/**
 * Narrative route tests (consumer/06). The route is a thin adapter: it
 * extracts the Bearer <redacted> from headers and calls exactly one service
 * method. The service is faked; its contract is covered in
 * narrative.service.test.ts and narrative.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EstimateResponse } from '@feasly/contracts';
import type { NarrativeService } from '../src/services/narrative.service';
import { createNarrativeRoute } from '../src/routes/narrative.route';

function deps() {
  const mocks = {
    generateNarrative: vi.fn(
      async (token: unknown, id: string): Promise<EstimateResponse> => ({
        estimateId: id,
        addressKey: 'calgary-123-fake-st-nw',
        inputs: {
          sqft: 2000,
          tier: 'standard',
          garage: 'double',
          basement: 'finished',
        },
        figures: {
          build: { low: 400000, base: 450000, high: 500000 },
          total: { low: 1050000, base: 1100000, high: 1150000 },
          land: { value: 650000 },
        },
        rows: [
          {
            key: 'structure',
            label: 'Structure',
            range: { low: 200000, base: 225000, high: 250000 },
          },
        ],
        costDataVersion: 'v0.1.0-unclibrated',
        createdAt: new Date('2026-09-25T07:30:00.000Z').toISOString(),
        disclaimer: 'Preliminary estimate — not a quote.',
        narrative: 'narrative-body',
        narrativeGeneratedAt: new Date('2026-09-25T07:30:00.000Z').toISOString(),
      }),
    ),
  };
  return {
    narrative: mocks as unknown as NarrativeService,
    mocks,
  };
}

describe('narrative route delegation', () => {
  it('passes the Bearer <redacted> and estimate id to the service', async () => {
    const d = deps();
    await createNarrativeRoute(d).generateNarrative(
      { authorization: 'Bearer t1' },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(d.mocks.generateNarrative).toHaveBeenCalledWith(
      't1',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });

  it('passes undefined when no token is present (service 401s)', async () => {
    const d = deps();
    await createNarrativeRoute(d).generateNarrative({}, 'some-id');
    expect(d.mocks.generateNarrative).toHaveBeenCalledWith(undefined, 'some-id');
  });

  it('returns the service result untouched', async () => {
    const d = deps();
    const result = await createNarrativeRoute(d).generateNarrative(
      { authorization: 'Bearer t1' },
      'some-id',
    );
    expect(result.narrative).toBe('narrative-body');
    expect(result.estimateId).toBe('some-id');
  });
});
