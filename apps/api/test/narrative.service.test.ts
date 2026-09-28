/**
 * Narrative worker tests (consumer/06).
 *
 * Covers: happy path, cached result (no second provider call), invented
 * dollar rejection, retry behavior, cross-user 403, invalid/expired bearer,
 * rate limit, provider no-network log mode, Meta provider parsing/error
 * redaction, and store persistence.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  NARRATIVE_FOOTER,
  type NarrativePrompt,
} from '@feasly/cost-engine';
import { createNarrativeService } from '../src/services/narrative.service';
import { createLogNarrativeProvider } from '../src/services/narrative/providers/log.provider';
import { createOpenAiCompatibleNarrativeProvider, chatCompletionsUrl } from '../src/services/narrative/providers/openai-compatible.provider';
import { buildStaticGuideNarrative } from '../src/services/narrative/static-guide';
import { NarrativeProviderError } from '../src/services/narrative/narrative.types';
import type {
  NarrativeProvider,
  NarrativeProviderResult,
} from '../src/services/narrative/narrative.types';
import type {
  EstimateRecord,
  EstimateStore,
} from '../src/services/estimate.store';
import type { MagicLinkStore } from '../src/services/magic-link.store';
import type { LeadStore } from '../src/services/lead.store';

const ESTIMATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEAD_ID = 'lead-1';
const OTHER_LEAD_ID = 'lead-2';
const TOKEN = 'valid-token';
const OTHER_TOKEN = 'other-token';
const NOW = new Date('2026-09-25T12:00:00Z');

function makeEstimate(overrides: Partial<EstimateRecord> = {}): EstimateRecord {
  return {
    id: ESTIMATE_ID,
    projectType: 'new_build',
    addressKey: 'calgary-123-fake-st-nw',
    inputs: {
      address: '123 Fake St NW',
      scope: { buildSqft: 2200, tier: 'standard' },
    },
    figures: {
      build: { low: 400000, base: 450000, high: 500000 },
      total: { low: 500000, base: 550000, high: 600000 },
      land: { value: 200000 },
    },
    rows: [],
    costDataVersion: 'v0.1.0-unclibrated',
    createdAt: NOW,
    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
    ...overrides,
  };
}

function makeStores(estimateOverrides: Partial<EstimateRecord> = {}) {
  const estimate = makeEstimate(estimateOverrides);
  const records = new Map<string, EstimateRecord>([[ESTIMATE_ID, estimate]]);
  const estimates: EstimateStore = {
    save: async (record: EstimateRecord) => {
      records.set(record.id, record);
    },
    findById: async (id: string) => records.get(id) ?? null,
    setNarrative: async ({ id, narrative, generatedAt }) => {
      const rec = records.get(id);
      if (!rec || rec.narrative) return false;
      records.set(id, {
        ...rec,
        narrative,
        narrativeGeneratedAt: generatedAt,
      });
      return true;
    },
    findByAddressKey: async () => [],
  };

  const magicLinks = {
    findByToken: vi.fn(async (token: string) => {
      if (token === TOKEN)
        return {
          id: 'mlink-1',
          leadId: LEAD_ID,
          purpose: 'narrative',
          tokenHash: 'hash',
          expiresAt: new Date(Date.now() + 3600000),
          usedAt: null,
          revokedAt: null,
          createdAt: NOW,
        };
      if (token === OTHER_TOKEN)
        return {
          id: 'mlink-2',
          leadId: OTHER_LEAD_ID,
          purpose: 'narrative',
          tokenHash: 'hash2',
          expiresAt: new Date(Date.now() + 3600000),
          usedAt: null,
          revokedAt: null,
          createdAt: NOW,
        };
      return null;
    }),
  } as unknown as MagicLinkStore;

  const leads = {
    findById: vi.fn(async (id: string) => {
      if (id === LEAD_ID)
        return { id: LEAD_ID, email: 'test@example.com', estimateId: ESTIMATE_ID };
      if (id === OTHER_LEAD_ID)
        return {
          id: OTHER_LEAD_ID,
          email: 'other@example.com',
          estimateId: 'other-estimate',
        };
      return null;
    }),
  } as unknown as LeadStore;

  const opsAlerts = {
    notifyFailure: vi.fn(async () => {}),
  };

  // Community context fakes (prompt enrichment): Beltline with stats.
  const properties = {
    getProperty: vi.fn(async () => ({ community: 'Beltline' })),
  } as unknown as import('../src/services/property.service').PropertyService;

  const communityStats = {
    getBySlug: vi.fn(async (slug: string) =>
      slug === 'beltline'
        ? {
            slug: 'beltline',
            name: 'Beltline',
            avgAssessedValue: 750000,
            assessmentCount: 1234,
            avgLotSqft: 5000,
            refreshedAt: new Date('2026-09-01T00:00:00Z'),
          }
        : null,
    ),
  } as unknown as import('../src/services/community-stats.service').CommunityStatsService;

  return { estimates, magicLinks, leads, opsAlerts, records, properties, communityStats };
}

function makeProvider(text: string): NarrativeProvider & { calls: number } {
  const p = {
    calls: 0,
    synthetic: false,
    async generate(_prompt: NarrativePrompt): Promise<NarrativeProviderResult> {
      p.calls++;
      return { text, model: 'test-model' };
    },
  };
  return p;
}

// Valid narrative: no invented dollars, includes the verbatim footer.
const VALID_TEXT = `This is a valid narrative about the estimate. ${NARRATIVE_FOOTER}`;

describe('narrative service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates and persists narrative on happy path', async () => {
    const { estimates, magicLinks, leads, opsAlerts, records, properties, communityStats } = makeStores();
    const provider = makeProvider(VALID_TEXT);
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.estimateId).toBe(ESTIMATE_ID);
    expect(result.narrative).toBe(VALID_TEXT);
    expect(result.cached).toBe(false);
    expect(result.narrativeSource).toBe('ai');
    expect(provider.calls).toBe(1);

    // Persisted
    const stored = records.get(ESTIMATE_ID);
    expect(stored?.narrative).toBe(VALID_TEXT);
    expect(stored?.narrativeGeneratedAt).toBeInstanceOf(Date);
  });

  it('returns cached narrative without calling provider', async () => {
    const cachedText = `Cached narrative text. ${NARRATIVE_FOOTER}`;
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores({
      narrative: cachedText,
      narrativeGeneratedAt: NOW,
    });
    const provider = makeProvider('New narrative that should not be used.');
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(cachedText);
    expect(result.cached).toBe(true);
    // Cached rows always predate the static guide (never persisted).
    expect(result.narrativeSource).toBe('ai');
    expect(provider.calls).toBe(0);
  });

  it('rejects invented dollar amounts — then serves the static guide (BE-9)', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores();
    // Provider returns text with a dollar amount not in the figures
    const provider = makeProvider(
      `This will cost $999,999 which is invented. ${NARRATIVE_FOOTER}`,
    );
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    // validateNarrative rejects the invented figures on both the initial
    // attempt and the repair retry — the invented text never reaches the
    // user. The service then serves the static guide (not a 502).
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(provider.calls).toBe(2); // initial + one repair retry
    expect(result.narrative).toBe(buildStaticGuideNarrative());
    expect(result.narrative).not.toContain('$999,999');
    expect(result.narrativeSource).toBe('static-guide');
    expect(opsAlerts.notifyFailure).toHaveBeenCalled();
  });

  it('retries once after invalid output then succeeds', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores();
    let calls = 0;
    const provider: NarrativeProvider = {
      synthetic: false,
      generate: async (_prompt: NarrativePrompt) => {
        calls++;
        if (calls === 1) return { text: 'Bad $123 output.', model: 'test' };
        return { text: VALID_TEXT, model: 'test' };
      },
    };
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(VALID_TEXT);
    expect(calls).toBe(2);
  });

  it('appends the footer deterministically when the model omits it (no 502)', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores();
    // Regression: a model upgrade once dropped the verbatim footer and the
    // worker 502'd on an otherwise good narrative. The footer is now
    // appended deterministically instead of required from the model.
    const provider = makeProvider('This is a valid narrative about the estimate.');
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(
      `This is a valid narrative about the estimate.\n\n${NARRATIVE_FOOTER}`,
    );
    expect(opsAlerts.notifyFailure).not.toHaveBeenCalled();
  });

  it('rejects cross-user access with 403', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores();
    const provider = makeProvider(VALID_TEXT);
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    // OTHER_TOKEN belongs to OTHER_LEAD_ID which owns a different estimate
    const error = await service
      .generateNarrative(OTHER_TOKEN, ESTIMATE_ID)
      .catch((e) => e);
    expect(error.status).toBe(403);
    expect(provider.calls).toBe(0);
  });

  it('rejects invalid bearer token with 401', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores();
    const provider = makeProvider(VALID_TEXT);
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const error = await service
      .generateNarrative('invalid-token', ESTIMATE_ID)
      .catch((e) => e);
    expect(error.status).toBe(401);
    expect(provider.calls).toBe(0);
  });

  it('enforces 5/day rate limit per estimate', async () => {
    const { estimates, magicLinks, leads, opsAlerts, records, properties, communityStats } = makeStores();
    const provider = makeProvider(VALID_TEXT);
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    // First 5 should succeed (clear narrative each time to avoid cache)
    for (let i = 0; i < 5; i++) {
      const est = records.get(ESTIMATE_ID);
      if (est) {
        records.set(ESTIMATE_ID, {
          ...est,
          narrative: null,
          narrativeGeneratedAt: null,
        });
      }
      await service.generateNarrative(TOKEN, ESTIMATE_ID);
    }

    // 6th should fail
    const est = records.get(ESTIMATE_ID);
    if (est) {
      records.set(ESTIMATE_ID, {
        ...est,
        narrative: null,
        narrativeGeneratedAt: null,
      });
    }
    const error = await service
      .generateNarrative(TOKEN, ESTIMATE_ID)
      .catch((e) => e);
    expect(error.status).toBe(429);
  });

  it('returns 404 for unknown estimate', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } = makeStores();
    const provider = makeProvider(VALID_TEXT);
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const error = await service
      .generateNarrative(TOKEN, '00000000-0000-4000-8000-000000000000')
      .catch((e) => e);
    expect(error.status).toBe(404);
  });
});

describe('log narrative provider', () => {
  it('generates deterministic text without network', async () => {
    const provider = createLogNarrativeProvider();
    const prompt: NarrativePrompt = {
      system: 'System prompt',
      user: 'User prompt with figures',
    };
    const result = await provider.generate(prompt);

    expect(result.text).toContain('synthetic');
    expect(result.model).toBe('log-placeholder');
  });
});

describe('openai-compatible narrative provider', () => {
  it('fails closed without API key', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
    });
    const prompt: NarrativePrompt = {
      system: 'System',
      user: 'User',
    };
    await expect(provider.generate(prompt)).rejects.toThrow(/API key/);
  });

  it('does not leak API key in error messages', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'secret-key-12345', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: async () => {
        throw new Error('Network failed with secret-key-12345 in message');
      },
    });

    const prompt: NarrativePrompt = {
      system: 'System',
      user: 'User',
    };
    const error = await provider.generate(prompt).catch((e) => e);

    // The provider uses a generic message, never including the key
    expect(error.message).not.toContain('secret-key-12345');
    expect(error.message).toBe('LLM API request failed');
  });

  it('fails closed naming NARRATIVE_ENDPOINT when no endpoint is configured', () => {
    expect(() =>
      createOpenAiCompatibleNarrativeProvider({ targets: [{ label: 'test', models: ['test-model'] }] }),
    ).toThrow(/NARRATIVE_ENDPOINT is not configured/);
  });

  it('appends /chat/completions to a bare base URL', async () => {
    const seen: string[] = [];
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['gemini-3.8-flash'], endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/' }],
      fetchImpl: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'A fine neighbourhood summary.' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const result = await provider.generate({
      system: 'System',
      user: 'User',
    });
    expect(seen).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ]);
    expect(result.text).toBe('A fine neighbourhood summary.');
  });

  it('surfaces the upstream error message on HTTP failure (2026-09-27 Gemini 400)', async () => {
    // Regression: a bare "HTTP 400" told nobody whether the key or the
    // request was bad. The provider now carries the upstream message.
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['gemini-3.8-flash'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            {
              error: {
                code: 400,
                message: 'Please pass a valid API key',
                status: 'INVALID_ARGUMENT',
              },
            },
          ]),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    const error = await provider
      .generate({ system: 'System', user: 'User' })
      .catch((e) => e);
    expect(error.message).toContain('HTTP 400');
    expect(error.message).toContain('Please pass a valid API key');
    expect(error.message).not.toContain('test-key');
  });

  it('falls back to the status-only message when the error body is unusable', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async () =>
        new Response('not json', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        })) as typeof fetch,
    });
    const error = await provider
      .generate({ system: 'System', user: 'User' })
      .catch((e) => e);
    expect(error.message).toBe(
      'LLM API returned HTTP 503 for model test-model',
    );
  });

  it('trims whitespace pasted around the API key', async () => {
    const seen: string[] = [];
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: '  test-key\n', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(
          (init?.headers as Record<string, string>)?.['authorization'] ?? '',
        );
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    await provider.generate({ system: 'System', user: 'User' });
    expect(seen).toEqual(['Bearer test-key']);
  });

  it('fails closed on a whitespace-only API key', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: '   \n ', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
    });
    await expect(
      provider.generate({ system: 'System', user: 'User' }),
    ).rejects.toThrow(/API key/);
  });
});

describe('chatCompletionsUrl', () => {
  it('leaves a full chat-completions URL unchanged', () => {
    expect(chatCompletionsUrl('https://example.com/v1/chat/completions')).toBe(
      'https://example.com/v1/chat/completions',
    );
  });

  it('appends /chat/completions to a bare base, tolerating trailing slashes', () => {
    expect(chatCompletionsUrl('https://example.com/v1/')).toBe(
      'https://example.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://example.com/v1')).toBe(
      'https://example.com/v1/chat/completions',
    );
  });
});

describe('synthetic placeholder guard (goal_aec0b247775d)', () => {
  it('serves the static Calgary guide instead of the log provider placeholder (BE-9)', async () => {
    const { estimates, magicLinks, leads, opsAlerts, records, properties, communityStats } =
      makeStores();
    const provider = createLogNarrativeProvider();
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.estimateId).toBe(ESTIMATE_ID);
    expect(result.narrative).toBe(buildStaticGuideNarrative());
    expect(result.narrative).not.toContain('synthetic narrative placeholder');
    expect(result.narrativeSource).toBe('static-guide');
    expect(result.cached).toBe(false);
    // Never persisted: the next read retries the AI chain, it never
    // serves the guide from the row.
    expect(records.get(ESTIMATE_ID)?.narrative).toBeNull();
    expect(opsAlerts.notifyFailure).not.toHaveBeenCalled();
  });

  it('does not serve a pre-guard placeholder from cache', async () => {
    // Simulate a row persisted before the guard existed: the literal text
    // the log provider produces (built by the real provider, so the test
    // breaks if the placeholder wording ever changes).
    const placeholder = await createLogNarrativeProvider().generate({
      system: 's',
      user: 'u',
    });
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } =
      makeStores({
        narrative: placeholder.text,
        narrativeGeneratedAt: NOW,
      });
    const provider = createLogNarrativeProvider();
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(buildStaticGuideNarrative());
    expect(result.narrative).not.toContain('synthetic narrative placeholder');
    expect(result.narrativeSource).toBe('static-guide');
  });

  it('still serves a real cached narrative (no over-filtering)', async () => {
    const realText = `A genuine AI summary of the estimate. ${NARRATIVE_FOOTER}`;
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } =
      makeStores({
        narrative: realText,
        narrativeGeneratedAt: NOW,
      });
    const provider = createLogNarrativeProvider();
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(realText);
    expect(result.cached).toBe(true);
  });

  it('filters synthetic text even when the provider flag is missing (backstop)', async () => {
    // A provider that forgot `synthetic: true` but emits the marker text
    // must still have its output dropped. (`synthetic` is required by the
    // type, so the omission is forced through a cast — a JS caller could
    // still do this at runtime.)
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } =
      makeStores();
    const provider = {
      generate: async () => ({
        text: `Oops, a synthetic narrative placeholder leaked. ${NARRATIVE_FOOTER}`,
        model: 'forgetful-provider',
      }),
    } as unknown as NarrativeProvider;
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(buildStaticGuideNarrative());
    expect(result.narrativeSource).toBe('static-guide');
  });
});

describe('narrative prompt community enrichment', () => {
  it('includes the neighbourhood section in the prompt', async () => {
    const { estimates, magicLinks, leads, opsAlerts, properties, communityStats } =
      makeStores();
    let seen: NarrativePrompt | undefined;
    const provider: NarrativeProvider = {
      synthetic: false,
      generate: async (prompt: NarrativePrompt) => {
        seen = prompt;
        return { text: VALID_TEXT, model: 'test-model' };
      },
    };
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(seen?.user).toContain('Project: New home build in Beltline, Calgary');
    expect(seen?.user).toContain(
      'Neighbourhood: Beltline (City of Calgary assessment data, refreshed September 2026)',
    );
    expect(seen?.user).toContain(
      'Average single-family home assessed value: $750,000 (City-assessed value, not market value)',
    );
    expect(seen?.system).toContain('Neighbourhood — write for a homebuyer');
    expect(seen?.system).toContain('Never invent school names or ratings.');
  });

  it('degrades to city-only facts when community lookups fail', async () => {
    const { estimates, magicLinks, leads, opsAlerts, communityStats } =
      makeStores();
    const failingProperties = {
      getProperty: async () => {
        throw new Error('city API down');
      },
    } as unknown as import('../src/services/property.service').PropertyService;
    let seen: NarrativePrompt | undefined;
    const provider: NarrativeProvider = {
      synthetic: false,
      generate: async (prompt: NarrativePrompt) => {
        seen = prompt;
        return { text: VALID_TEXT, model: 'test-model' };
      },
    };
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties: failingProperties,
      communityStats,
    });

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(VALID_TEXT);
    expect(seen?.user).toContain('Project: New home build in Calgary');
    expect(seen?.user).not.toContain('Neighbourhood:');
  });
});

describe('narrative model chain (BE-9)', () => {
  const ENDPOINT = 'https://example.com/v1/chat/completions';
  const PROMPT: NarrativePrompt = { system: 'System', user: 'User' };

  const okBody = (text: string) =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: text } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const errBody = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const seenModel = (init?: RequestInit) =>
    (JSON.parse(String(init?.body)) as { model: string }).model;

  function chainProvider(
    fetchImpl: typeof fetch,
    models: readonly string[] = ['primary-model', 'backup-model'],
  ) {
    return createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models, endpoint: ENDPOINT }],
      fetchImpl,
    });
  }

  it('falls through to the backup model on 503 and reports which model served', async () => {
    const seen: string[] = [];
    const provider = chainProvider((async (_url, init) => {
      const model = seenModel(init);
      seen.push(model);
      return model === 'primary-model'
        ? errBody(503, 'The model is overloaded')
        : okBody('Backup model prose.');
    }) as typeof fetch);

    const result = await provider.generate(PROMPT);

    expect(seen).toEqual(['primary-model', 'backup-model']);
    expect(result.text).toBe('Backup model prose.');
    expect(result.model).toBe('backup-model');
  });

  it('chains on 429 rate-limit responses', async () => {
    const seen: string[] = [];
    const provider = chainProvider((async (_url, init) => {
      const model = seenModel(init);
      seen.push(model);
      return model === 'primary-model'
        ? errBody(429, 'Rate limit exceeded')
        : okBody('Backup model prose.');
    }) as typeof fetch);

    const result = await provider.generate(PROMPT);

    expect(seen).toEqual(['primary-model', 'backup-model']);
    expect(result.model).toBe('backup-model');
  });

  it('chains when the primary times out', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['primary-model', 'backup-model'], endpoint: ENDPOINT }],
      timeoutMs: 50,
      fetchImpl: (async (_url, init) => {
        if (seenModel(init) === 'primary-model') {
          // Simulate a hanging upstream: wait for the provider's
          // AbortSignal.timeout() to fire, then fail like a real client.
          await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted.', 'TimeoutError'),
              ),
            );
          });
        }
        return okBody('Backup model prose.');
      }) as typeof fetch,
    });

    const result = await provider.generate(PROMPT);

    expect(result.model).toBe('backup-model');
  });

  it('fails fast on 400 — no backup model attempted', async () => {
    let calls = 0;
    const provider = chainProvider((async () => {
      calls++;
      return errBody(400, 'Invalid request');
    }) as typeof fetch);

    const error = await provider.generate(PROMPT).catch((e) => e);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(NarrativeProviderError);
    expect(error.status).toBe(400);
    expect(error.message).toContain('HTTP 400');
  });

  it('throws the last model error when the chain is exhausted', async () => {
    const provider = chainProvider(
      (async () => errBody(503, 'still overloaded')) as typeof fetch,
      ['model-one', 'model-two'],
    );

    const error = await provider.generate(PROMPT).catch((e) => e);

    expect(error).toBeInstanceOf(NarrativeProviderError);
    expect(error.message).toContain('HTTP 503');
    expect(error.message).toContain('model-two');
  });

  it('throws when no provider targets are configured', () => {
    expect(() => createOpenAiCompatibleNarrativeProvider({ targets: [] })).toThrow(
      /No narrative provider targets/,
    );
  });

  describe('cross-provider fallback (Gemini -> Groq)', () => {
    const GEMINI_URL = 'https://gemini.example/v1/chat/completions';
    const GROQ_URL = 'https://groq.example/v1/chat/completions';

    function twoTargetProvider(
      fetchImpl: typeof fetch,
      groqApiKey: string | undefined,
    ) {
      return createOpenAiCompatibleNarrativeProvider({
        targets: [
          {
            label: 'gemini',
            apiKey: 'gemini-key',
            models: ['gemini-3.8-flash'],
            endpoint: 'https://gemini.example/v1',
          },
          {
            label: 'groq',
            apiKey: groqApiKey,
            models: ['llama-3.3-70b-versatile'],
            endpoint: 'https://groq.example/v1',
          },
        ],
        fetchImpl,
      });
    }

    it('falls through to the Groq fallback target on 429 from Gemini', async () => {
      const seenUrls: string[] = [];
      const seenModels: string[] = [];
      const provider = twoTargetProvider((async (url, init) => {
        seenUrls.push(String(url));
        const model = seenModel(init);
        seenModels.push(model);
        return model === 'gemini-3.8-flash'
          ? errBody(429, 'Rate limit exceeded')
          : okBody('Groq fallback prose.');
      }) as typeof fetch,
        'groq-key',
      );

      const result = await provider.generate(PROMPT);

      expect(seenUrls).toEqual([GEMINI_URL, GROQ_URL]);
      expect(seenModels).toEqual([
        'gemini-3.8-flash',
        'llama-3.3-70b-versatile',
      ]);
      expect(result.text).toBe('Groq fallback prose.');
      expect(result.model).toBe('llama-3.3-70b-versatile');
    });

    it('falls through to Groq on 503 from Gemini', async () => {
      const provider = twoTargetProvider((async (_url, init) => {
        return seenModel(init) === 'gemini-3.8-flash'
          ? errBody(503, 'The model is overloaded')
          : okBody('Groq fallback prose.');
      }) as typeof fetch,
        'groq-key',
      );

      const result = await provider.generate(PROMPT);

      expect(result.model).toBe('llama-3.3-70b-versatile');
    });

    it('skips the Groq fallback target gracefully when its key is absent', async () => {
      const seenUrls: string[] = [];
      const provider = twoTargetProvider(
        (async (url) => {
          seenUrls.push(String(url));
          return errBody(429, 'Rate limit exceeded');
        }) as typeof fetch,
        undefined, // no Groq key yet — Karan provisions it later
      );

      const error = await provider.generate(PROMPT).catch((e) => e);

      // Only Gemini was attempted; the keyless Groq step was skipped, not failed.
      expect(seenUrls).toEqual([GEMINI_URL]);
      expect(error).toBeInstanceOf(NarrativeProviderError);
      expect(error.message).toContain('HTTP 429');
    });

    it('fails fast on 404 without trying the fallback target', async () => {
      const seenUrls: string[] = [];
      const provider = twoTargetProvider((async (url) => {
        seenUrls.push(String(url));
        return errBody(404, 'Model not found');
      }) as typeof fetch,
        'groq-key',
      );

      const error = await provider.generate(PROMPT).catch((e) => e);

      // Unknown-model is a config error — fail fast, don't burn the fallback.
      expect(seenUrls).toEqual([GEMINI_URL]);
      expect(error.status).toBe(404);
    });
  });
});

describe('narrative static-guide fallback (BE-9)', () => {
  function makeService(provider: NarrativeProvider) {
    const {
      estimates,
      magicLinks,
      leads,
      opsAlerts,
      records,
      properties,
      communityStats,
    } = makeStores();
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });
    return { service, opsAlerts, records };
  }

  it('serves the static guide — not a 502 — when every model fails', async () => {
    const failing: NarrativeProvider = {
      synthetic: false,
      generate: async () => {
        throw new NarrativeProviderError(
          'LLM API returned HTTP 503 for model backup-model',
        );
      },
    };
    const { service, opsAlerts, records } = makeService(failing);

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(buildStaticGuideNarrative());
    expect(result.narrativeSource).toBe('static-guide');
    expect(result.cached).toBe(false);
    // Never persisted — the next visit retries the AI chain.
    expect(records.get(ESTIMATE_ID)?.narrative).toBeNull();
    // Ops still alerted — the outage stays visible.
    expect(opsAlerts.notifyFailure).toHaveBeenCalledWith(
      'narrative_worker_failed',
      expect.objectContaining({ consecutiveFailures: 1 }),
    );
  });

  it('serves the static guide when validation fails after the repair retry', async () => {
    const { service } = makeService(makeProvider('Bad $123 output.'));

    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);

    expect(result.narrative).toBe(buildStaticGuideNarrative());
    expect(result.narrativeSource).toBe('static-guide');
  });

  it('the static guide has no dollar figures and the footer exactly once', () => {
    const guide = buildStaticGuideNarrative();
    expect(guide).not.toMatch(/\$/);
    expect(guide.split(NARRATIVE_FOOTER).length - 1).toBe(1);
  });

  it('counts a full model chain as ONE generation against the 5/day budget', async () => {
    // A chain provider: the primary 503s, the backup succeeds — two HTTP
    // calls inside a single service request.
    let calls = 0;
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['primary-model', 'backup-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async () => {
        calls++;
        return calls % 2 === 1
          ? new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(
              JSON.stringify({
                choices: [{ message: { content: VALID_TEXT } }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
      }) as typeof fetch,
    });
    const {
      estimates,
      magicLinks,
      leads,
      opsAlerts,
      records,
      properties,
      communityStats,
    } = makeStores();
    const service = createNarrativeService({
      magicLinks,
      leads,
      estimates,
      provider,
      opsAlerts,
      properties,
      communityStats,
    });

    for (let i = 0; i < 5; i++) {
      const est = records.get(ESTIMATE_ID);
      if (est) {
        records.set(ESTIMATE_ID, {
          ...est,
          narrative: null,
          narrativeGeneratedAt: null,
        });
      }
      const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
      expect(result.narrativeSource).toBe('ai');
      expect(result.narrative).toBe(VALID_TEXT);
    }
    expect(calls).toBe(10); // 5 service calls × 2 model attempts

    // The 6th service call hits the budget — proving each chain cost one.
    const est = records.get(ESTIMATE_ID);
    if (est) {
      records.set(ESTIMATE_ID, {
        ...est,
        narrative: null,
        narrativeGeneratedAt: null,
      });
    }
    const error = await service
      .generateNarrative(TOKEN, ESTIMATE_ID)
      .catch((e) => e);
    expect(error.status).toBe(429);
  });
});
