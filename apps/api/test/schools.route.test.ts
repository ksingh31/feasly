/**
 * Schools directory route (#774): validation, filters passed through to the
 * read service, 404 for an unknown id, attribution + disclaimer on every
 * response, and the function.json bindings for both endpoints.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { School } from '@feasly/contracts';
import { createSchoolsRoute } from '../src/routes/schools.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import {
  SCHOOLS_DISCLAIMER,
  type SchoolDirectoryQuery,
  type SchoolDirectoryReadService,
} from '../src/services/neighbourhood-data/school-directory-read.service';

const SCHOOL: School = {
  id: 'city-a1',
  name: 'Altadore School',
  type: 'public_cbe',
  board: 'Calgary Board of Education',
  authority: 'The Calgary School Division',
  grades: 'Elementary',
  programs: [],
  address: '4506 16 ST SW',
  postalCode: 'T2T4H9',
  lat: 51.012,
  lng: -114.098,
  website: null,
  tuition: false,
  communityCode: 'ALT',
  communityName: 'ALTADORE',
  sources: { name: 'calgary-open-data', type: 'alberta-authority-list' },
  refreshedAt: '2026-11-01T00:00:00.000Z',
};

const ATTRIBUTION = {
  id: 'calgary-open-data' as const,
  label: 'City',
  licence: 'OGL',
  url: 'https://data.calgary.ca',
};

function fakeService() {
  const calls: SchoolDirectoryQuery[] = [];
  const service: SchoolDirectoryReadService = {
    listSchools: async (query) => {
      calls.push(query);
      return { schools: [SCHOOL], attributions: [ATTRIBUTION] };
    },
    getSchool: async (id) => (id === SCHOOL.id ? { school: SCHOOL, attributions: [ATTRIBUTION] } : null),
  };
  return { service, calls };
}

async function expectProblem(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  expect((err as HttpError).code).toBe(code);
}

describe('schools route (#774)', () => {
  it('lists with no filter, adding the disclaimer and attributions', async () => {
    const { service, calls } = fakeService();
    const res = await createSchoolsRoute({ schools: service }).list(undefined);
    expect(calls).toEqual([{}]);
    expect(res).toEqual({ schools: [SCHOOL], attributions: [ATTRIBUTION], disclaimer: SCHOOLS_DISCLAIMER });
    expect(res.disclaimer).toMatch(/confirm/i);
  });

  it('passes community and type filters through', async () => {
    const { service, calls } = fakeService();
    await createSchoolsRoute({ schools: service }).list({ community: 'alt', type: 'charter' });
    expect(calls).toEqual([{ communityCode: 'alt', type: 'charter' }]);
  });

  it('treats empty filters as absent', async () => {
    const { service, calls } = fakeService();
    await createSchoolsRoute({ schools: service }).list({ community: ' ', type: '' });
    expect(calls).toEqual([{}]);
  });

  it('400 for an unknown type or malformed community', async () => {
    const route = createSchoolsRoute({ schools: fakeService().service });
    await expectProblem(route.list({ type: 'boarding' }), 400, ErrorCodes.VALIDATION_FAILED);
    await expectProblem(route.list({ community: "ALT' OR 1=1" }), 400, ErrorCodes.VALIDATION_FAILED);
  });

  it('gets one school; 404 when unknown; 400 for a malformed id', async () => {
    const route = createSchoolsRoute({ schools: fakeService().service });
    expect(await route.get('city-a1')).toEqual({
      school: SCHOOL,
      attributions: [ATTRIBUTION],
      disclaimer: SCHOOLS_DISCLAIMER,
    });
    await expectProblem(route.get('city-zz'), 404, ErrorCodes.NOT_FOUND);
    await expectProblem(route.get('../etc'), 400, ErrorCodes.VALIDATION_FAILED);
    await expectProblem(route.get(undefined), 400, ErrorCodes.VALIDATION_FAILED);
  });

  it('function.json binds anonymous GETs on v1/schools and v1/schools/{id}', () => {
    for (const [dir, route] of [
      ['schools-list', 'v1/schools'],
      ['schools-get', 'v1/schools/{id}'],
    ] as const) {
      const fj = JSON.parse(readFileSync(join(__dirname, '..', dir, 'function.json'), 'utf8'));
      expect(fj.bindings[0]).toMatchObject({ authLevel: 'anonymous', type: 'httpTrigger', route });
      expect(fj.bindings[0].methods).toContain('get');
    }
  });
});
