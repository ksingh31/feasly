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

const RECORD: PropertyRecord = {
  addressKey: '1600 90 AV SW',
  address: '1600 90 Av SW, Calgary, AB',
  community: 'BAYVIEW',
  lotSqft: 452960,
  zoning: 'C-C2',
  assessedValue: 60150000,
  assessmentYear: 2026,
  yearBuilt: 1980,
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

async function catchError(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('property route', () => {
  describe('autocomplete', () => {
    it('delegates to the service and returns suggestions', async () => {
      const route = createPropertyRoute({ property: serviceWith() });
      const res = await route.autocomplete('1600 90 Ave');
      expect(res).toEqual(SUGGESTIONS);
    });

    it('rejects a missing query with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ property: serviceWith() });
      const error = await catchError(route.autocomplete(undefined));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('rejects an empty query with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ property: serviceWith() });
      const error = await catchError(route.autocomplete('   '));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('rejects an overlong query with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ property: serviceWith() });
      const error = await catchError(route.autocomplete('x'.repeat(201)));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('propagates service errors unchanged', async () => {
      const route = createPropertyRoute({
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
      const route = createPropertyRoute({ property: serviceWith() });
      const res = await route.lookup('1600 90 AV SW');
      expect(res).toEqual(RECORD);
    });

    it('rejects a missing addressKey with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ property: serviceWith() });
      const error = await catchError(route.lookup(undefined));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('propagates NOT_FOUND from the service', async () => {
      const route = createPropertyRoute({
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
});
