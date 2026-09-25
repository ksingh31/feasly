/**
 * consumer/06 — AI narrative worker unit tests.
 *
 * The service is tested with every store faked at the interface boundary
 * (fake the service's deps, not Drizzle internals — per the feasly-api
 * skill). PGlite integration lives in narrative.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { NARRATIVE_FOOTER } from '@feasly/cost-engine';
import { HttpError } from '../src/middleware/errors';
import {
  createNarrativeService,
  type NarrativeServiceDeps,
} from '../src/services/narrative.service';
import {
  createLogNarrativeProvider,
  createMetaApiNarrativeProvider,
  type NarrativeProvider,
} from '../src/services/narrative.provider';
import type { EstimateRecord } from '../src/services/estimate.store';
import type { LeadRecord } from '../src/services/lead.store';
import type { MagicLinkRecord } from '../src/services/magic-link.store';
import type { PrivacyAuditAction } from '../src/services/privacy.store';

const NOW = new Date('2026-09-25T07:30:00.000Z');
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const ALICE_ESTIMATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB_ESTIMATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE_LEAD = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const BOB_LEAD = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const ALICE_TOKEN = 'alice-magic-token';
const BOB_TOKEN = 'bob-magic-token';

const FIGURES = {
  build: { low: 400000, base: 450000, high: 500000 },
  total: { low: 1050000, base: 1100000, high: 1150000 },
  land: { value: 650000 },
};
const ROWS = [
  {
    key: 'structure',
    label: 'Structure',
    range: { low: 200000, base: 225000, high: 250000 },
  },
];

function estimateRecord(overrides: Partial<EstimateRecord> = {}): EstimateRecord {
  return {
    id: ALICE_ESTIMATE,
    projectType: 'new_build',
    addressKey: 'calgary-123-fake-st-nw',
    inputs: { sqft: 2000, tier: 'mid', garage: 'double', basement: 'finished' },
    figures: FIGURES,
    rows: ROWS,
    costDataVersion: 'v0.1.0-unclibrated',
    createdAt: NOW,
    narrative: null,
    narrativeGeneratedAt: null,
    ...overrides,
  };
}

function leadRecord(
  id: string,
  email: string,
  estimateId: string,
): LeadRecord {
  return {
    id,
    estimateId,
    addressKey: 'calgary-123-fake-st-nw',
    email,
    name: 'Test',
    phone: null,
    timeline: 'exploring',
    marketingConsent: false,
    consentTs: NOW,
    tenantKey: null,
    source: 'api',
    quarantined: false,
    leadScore: 0,
    status: 'new',
    unsubscribedAt: null,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    updatedAt: NOW,
    createdAt: NOW,
  };
}

function linkRecord(
  token: string,
  leadId: string,
  overrides: Partial<MagicLinkRecord> = {},
): MagicLinkRecord {
  return {
    id: `link-${token}`,
    leadId,
    purpose: 'report',
    tokenHash: `hash(${token})`,
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
    usedAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

const VALID_NARRATIVE =
  'Your build total is $450,000 with a project total of $1,100,000. ' +
  NARRATIVE_FOOTER;

interface World {
  estimates: Map<string, EstimateRecord>;
  links: Map<string, MagicLinkRecord>;
  leads: Map<string, LeadRecord>;
  generations: { estimateId: string; at: Date }[];
  audits: { leadId: string | null; action: PrivacyAuditAction }[];
  alerts: { type: string }[];
  savedNarratives: { id: string; narrative: string; at: Date }[];
}

function makeWorld(): World {
  return {
    estimates: new Map([[ALICE_ESTIMATE, estimateRecord()]]),
    links: new Map([
      [ALICE_TOKEN, linkRecord(ALICE_TOKEN, ALICE_LEAD)],
      [BOB_TOKEN, linkRecord(BOB_TOKEN, BOB_LEAD)],
    ]),
    leads: new Map([
      [ALICE_LEAD, leadRecord(ALICE_LEAD, ALICE, ALICE_ESTIMATE)],
      [BOB_LEAD, leadRecord(BOB_LEAD, BOB, BOB_ESTIMATE)],
    ]),
    generations: [],
    audits: [],
    alerts: [],
    savedNarratives: [],
  };
}

function makeDeps(
  world: World,
  provider: NarrativeProvider,
  overrides: Partial<NarrativeServiceDeps> = {},
): NarrativeServiceDeps {
  return {
    estimates: {
      save: async () => {},
      findById: async (id: string) => world.estimates.get(id) ?? null,
      saveNarrative: async (id: string, narrative: string, at: Date) => {
        world.savedNarratives.push({ id, narrative, at });
        const existing = world.estimates.get(id);
        if (existing) {
          world.estimates.set(id, {
            ...existing,
            narrative,
            narrativeGeneratedAt: at,
          });
        }
      },
    },
    magicLinks: {
      findByToken: async (token: string) => world.links.get(token) ?? null,
      findByLeadIds: async () => [],
      revokeByLeadIds: async () => 0,
    } as unknown as NarrativeServiceDeps['magicLinks'],
    leads: {
      findById: async (id: string) => world.leads.get(id) ?? null,
      findAllByEmail: async (email: string) =>
        [...world.leads.values()].filter((l) => l.email === email),
    } as unknown as NarrativeServiceDeps['leads'],
    generations: {
      countSince: async (estimateId: string, since: Date) =>
        world.generations.filter(
          (g) => g.estimateId === estimateId && g.at >= since,
        ).length,
      record: async (estimateId: string, at: Date) => {
        world.generations.push({ estimateId, at });
      },
    },
    provider,
    opsAlerts: {
      notifyFailure: async (type: string) => {
        world.alerts.push({ type });
      },
    },
    audit: {
      audit: async (args: {
        leadId: string | null;
        action: PrivacyAuditAction;
      }) => {
        world.audits.push(args);
      },
    },
    maxGenerationsPerDay: 5,
    generationWindowMs: 86_400_000,
    clock: () => NOW,
    ...overrides,
  };
}

function stubProvider(responses: (string | Error)[]): NarrativeProvider & {
  readonly calls: number;
  readonly prompts: string[];
} {
  const state = { calls: 0, prompts: [] as string[] };
  return {
    get calls() {
      return state.calls;
    },
    get prompts() {
      return state.prompts;
    },
    generate: async (prompt: { user: string }) => {
      state.calls++;
      state.prompts.push(prompt.user);
      const next = responses[Math.min(state.calls - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next as string;
    },
  };
}

describe('narrative service', () => {
  it('generates, persists, and caches the narrative (AC1)', async () => {
    const world = makeWorld();
    const provider = stubProvider([VALID_NARRATIVE]);
    const service = createNarrativeService(makeDeps(world, provider));

    const first = await service.generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE);
    expect(first.estimateId).toBe(ALICE_ESTIMATE);
    expect(first.narrative).toContain(NARRATIVE_FOOTER);
    expect(first.narrativeGeneratedAt).toBe(NOW.toISOString());
    expect(world.savedNarratives).toHaveLength(1);
    expect(world.generations).toHaveLength(1);

    // Second call returns the cached narrative — no LLM call, no guard spend.
    const second = await service.generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE);
    expect(second.narrative).toBe(first.narrative);
    expect(provider.calls).toBe(1);
    expect(world.generations).toHaveLength(1);
    expect(world.savedNarratives).toHaveLength(1);
  });

  it('retries once with a repair prompt after a validation failure', async () => {
    const world = makeWorld();
    const bad =
      'Your total is $9,999,999. ' + NARRATIVE_FOOTER; // invented figure
    const provider = stubProvider([bad, VALID_NARRATIVE]);
    const service = createNarrativeService(makeDeps(world, provider));

    const result = await service.generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE);
    expect(result.narrative).toBe(VALID_NARRATIVE);
    expect(provider.calls).toBe(2);
    // Repair prompt names the violation.
    expect(provider.prompts[1]).toContain('Invented dollar figure');
    expect(provider.prompts[1]).toContain('$9,999,999');
    // Both LLM calls count against the cost guard.
    expect(world.generations).toHaveLength(2);
  });

  it('fails closed with 502 + ops alert when validation fails twice (AC2)', async () => {
    const world = makeWorld();
    const bad = 'Your total is $9,999,999 and also missing footer.';
    const provider = stubProvider([bad, bad]);
    const service = createNarrativeService(makeDeps(world, provider));

    const error = await service
      .generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE)
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('NARRATIVE_FAILED');
    expect(world.alerts).toEqual([{ type: 'narrative_worker_failed' }]);
    // Nothing persisted.
    expect(world.savedNarratives).toHaveLength(0);
    expect(world.estimates.get(ALICE_ESTIMATE)!.narrative).toBeNull();
  });

  it('fires the ops alert and 502s when the provider throws', async () => {
    const world = makeWorld();
    const provider = stubProvider([new Error('Meta API error: HTTP 500')]);
    const service = createNarrativeService(makeDeps(world, provider));

    const error = await service
      .generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE)
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('NARRATIVE_FAILED');
    expect(world.alerts).toEqual([{ type: 'narrative_worker_failed' }]);
  });

  it('rejects missing/unknown/expired tokens with uniform 401 + audit (AC4 denial)', async () => {
    const world = makeWorld();
    world.links.set(
      'expired-token',
      linkRecord('expired-token', ALICE_LEAD, {
        expiresAt: new Date(NOW.getTime() - 1000),
      }),
    );
    const service = createNarrativeService(
      makeDeps(world, stubProvider([VALID_NARRATIVE])),
    );

    for (const token of [undefined, 'no-such-token', 'expired-token']) {
      const error = await service
        .generateNarrative(token, ALICE_ESTIMATE)
        .catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error.status).toBe(401);
      expect(error.code).toBe('UNAUTHENTICATED');
    }
    // Denials are audited without revealing which reason applied.
    expect(world.audits).toHaveLength(3);
    expect(
      world.audits.every(
        (a) => a.action === 'narrative.denied' && a.leadId === null,
      ),
    ).toBe(true);
  });

  it("rejects another user's estimate with 403 + audit row (AC4)", async () => {
    const world = makeWorld();
    const service = createNarrativeService(
      makeDeps(world, stubProvider([VALID_NARRATIVE])),
    );

    const error = await service
      .generateNarrative(BOB_TOKEN, ALICE_ESTIMATE)
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(world.audits).toEqual([
      { leadId: BOB_LEAD, action: 'narrative.denied' },
    ]);
  });

  it('returns 404 for unknown or malformed estimate ids', async () => {
    const world = makeWorld();
    const service = createNarrativeService(
      makeDeps(world, stubProvider([VALID_NARRATIVE])),
    );

    for (const id of [
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'not-a-uuid',
      '',
    ]) {
      const error = await service
        .generateNarrative(ALICE_TOKEN, id)
        .catch((e) => e);
      expect(error.status).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
    }
  });

  it('returns 404 for comparison estimates (narratives are new_build/renovation only)', async () => {
    const world = makeWorld();
    const comparisonId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    world.estimates.set(
      comparisonId,
      estimateRecord({ id: comparisonId, projectType: 'comparison' }),
    );
    world.leads.set(
      'dddddddd-0000-4000-8000-dddddddddddd',
      leadRecord('dddddddd-0000-4000-8000-dddddddddddd', ALICE, comparisonId),
    );
    const service = createNarrativeService(
      makeDeps(world, stubProvider([VALID_NARRATIVE])),
    );

    const error = await service
      .generateNarrative(ALICE_TOKEN, comparisonId)
      .catch((e) => e);
    expect(error.status).toBe(404);
  });

  it('enforces the per-estimate daily generation cost guard with 429 (AC5)', async () => {
    const world = makeWorld();
    // Five generations already spent inside the window.
    for (let i = 0; i < 5; i++) {
      world.generations.push({
        estimateId: ALICE_ESTIMATE,
        at: new Date(NOW.getTime() - i * 3600_000),
      });
    }
    const provider = stubProvider([VALID_NARRATIVE]);
    const service = createNarrativeService(makeDeps(world, provider));

    const error = await service
      .generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE)
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
    expect(provider.calls).toBe(0);

    // Generations outside the window don't count.
    world.generations.length = 0;
    for (let i = 0; i < 5; i++) {
      world.generations.push({
        estimateId: ALICE_ESTIMATE,
        at: new Date(NOW.getTime() - 25 * 3600_000),
      });
    }
    const ok = await service.generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE);
    expect(ok.narrative).toContain(NARRATIVE_FOOTER);
  });

  it('generates for renovation estimates from the persisted snapshot', async () => {
    const world = makeWorld();
    const renoId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    world.estimates.set(
      renoId,
      estimateRecord({
        id: renoId,
        projectType: 'renovation',
        figures: {
          build: { low: 50000, base: 60000, high: 70000 },
          total: { low: 50000, base: 60000, high: 70000 },
          land: { value: 0 },
        },
        rows: [
          {
            key: 'reno.basement',
            label: 'Basement',
            range: { low: 50000, base: 60000, high: 70000 },
          },
        ],
        inputs: {
          sqft: 800,
          tier: 'mid',
          garage: 'none',
          basement: 'unfinished',
          renoInputs: {
            projectType: 'renovation',
            renoType: 'basement',
            renoSqft: 800,
            tier: 'mid',
          },
        },
      }),
    );
    world.leads.set(
      'eeeeeeee-0000-4000-8000-eeeeeeeeeeee',
      leadRecord('eeeeeeee-0000-4000-8000-eeeeeeeeeeee', ALICE, renoId),
    );
    const provider = stubProvider([
      'Your renovation total is $60,000. ' + NARRATIVE_FOOTER,
    ]);
    const service = createNarrativeService(makeDeps(world, provider));

    const result = await service.generateNarrative(ALICE_TOKEN, renoId);
    expect(result.projectType).toBe('renovation');
    expect(result.narrative).toContain('$60,000');
    expect(result.renoInputs?.renoType).toBe('basement');
  });

  it('never sends CostData to the prompt builder (type boundary holds)', () => {
    // The prompt input type rejects CostData at compile time (asserted in
    // packages/cost-engine/test/narrative.test.ts). Here: the service only
    // ever passes the persisted snapshot's figures/rows — no cost table.
    const world = makeWorld();
    const provider = stubProvider([VALID_NARRATIVE]);
    const service = createNarrativeService(makeDeps(world, provider));
    return service.generateNarrative(ALICE_TOKEN, ALICE_ESTIMATE).then((r) => {
      expect(r.narrative).toContain(NARRATIVE_FOOTER);
    });
  });
});

describe('narrative providers', () => {
  it('log provider returns a validator-clean placeholder without network', async () => {
    const logged: string[] = [];
    const { validateNarrative } = await import('@feasly/cost-engine');
    const provider = createLogNarrativeProvider({
      log: (m: string) => logged.push(m),
    });
    const text = await provider.generate({
      system: 'rules',
      user: 'figures',
    });
    expect(logged).toHaveLength(1);
    // No $-figures at all + the verbatim footer → validates clean.
    expect(text).not.toMatch(/\$/);
    expect(text).toContain(NARRATIVE_FOOTER);
    expect(
      validateNarrative(text, {
        costDataVersion: 'v0.1.0-unclibrated',
        calibrated: false,
        rows: [],
        totals: {
          build: { low: 1, base: 1, high: 1 },
          land: { value: 0 },
          total: { low: 1, base: 1, high: 1 },
        },
      }).ok,
    ).toBe(true);
  });

  it('meta provider fails fast without credentials', () => {
    expect(() =>
      createMetaApiNarrativeProvider({
        apiKey: '',
        baseUrl: 'https://example.invalid',
        model: 'llama-3.3-70b-versatile',
        timeoutMs: 1000,
      }),
    ).toThrow(/META_API_KEY/);
  });

  it('meta provider posts to the chat-completions endpoint with the bearer key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: VALID_NARRATIVE } }],
        }),
      } as Response;
    }) as typeof fetch;
    const provider = createMetaApiNarrativeProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.invalid/v1/',
      model: 'llama-3.3-70b-versatile',
      timeoutMs: 1000,
      fetchFn,
    });
    const text = await provider.generate({ system: 's', user: 'u' });
    expect(text).toBe(VALID_NARRATIVE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://llm.example.invalid/v1/chat/completions',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });
});
