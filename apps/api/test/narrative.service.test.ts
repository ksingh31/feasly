/**
 * Report narrative read path (consumer/06, reworked for #759) + the
 * narrative provider adapters.
 *
 * Read path: legacy per-estimate narrative → stored community narrative +
 * deterministic estimate sentence → static guide; auth/ownership; and zero
 * LLM calls however many reports are viewed (AC2). The provider tests cover
 * the adapters the monthly community-narrative job uses.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  NARRATIVE_FOOTER,
  validateNarrative,
  type NarrativePrompt,
} from '@feasly/cost-engine';
import { createNarrativeService } from '../src/services/narrative.service';
import { createCommunityNarrativeService } from '../src/services/community-narrative.service';
import type { CommunityNarrativeStore } from '../src/services/community-narrative.store';
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

const COMMUNITY_TEXT = `Beltline is a walkable inner-city neighbourhood. Homes average $750,000 (City-assessed value). ${NARRATIVE_FOOTER}`;

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

  // Stored monthly community narratives (#759): Beltline has one.
  const communityNarratives = {
    findServable: vi.fn(async (slug: string) =>
      slug === 'beltline'
        ? {
            communitySlug: 'beltline',
            period: '2026-09',
            narrative: COMMUNITY_TEXT,
            generatedAt: new Date('2026-08-31T09:00:00Z'),
          }
        : null,
    ),
  };

  return { estimates, magicLinks, leads, opsAlerts, records, properties, communityNarratives };
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


const SENTENCE =
  'For this 2,200 sq ft new home with a standard finish, our cost model puts the build ' +
  'cost between $400,000 and $500,000, with a typical figure of $450,000.';

function makeService(estimateOverrides: Partial<EstimateRecord> = {}) {
  const stores = makeStores(estimateOverrides);
  const service = createNarrativeService({
    magicLinks: stores.magicLinks,
    leads: stores.leads,
    estimates: stores.estimates,
    properties: stores.properties,
    communityNarratives: stores.communityNarratives,
    clock: () => NOW,
  });
  return { service, ...stores };
}

const SIZED_INPUTS = { sqft: 2200, tier: 'standard', garage: 'none', basement: 'unfinished' };

describe('narrative read path (#759)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves the stored community narrative with the deterministic estimate sentence', async () => {
    const { service, records } = makeService({ inputs: SIZED_INPUTS });
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrative).toBe(`${SENTENCE}\n\n${COMMUNITY_TEXT}`);
    expect(result.narrativeSource).toBe('ai');
    expect(result.cached).toBe(true);
    expect(result.narrativeGeneratedAt).toBe('2026-08-31T09:00:00.000Z');
    // Every figure is an engine figure or the community average.
    const est = records.get(ESTIMATE_ID)!;
    expect(est.narrative).toBeNull(); // nothing persisted on the estimate
  });

  it('every $-figure in the served text is from the engine or community stats', async () => {
    const { service } = makeService({ inputs: SIZED_INPUTS });
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    const figures = result.narrative.match(/\$\s?\d{1,3}(?:,\d{3})*/g) ?? [];
    expect(new Set(figures)).toEqual(new Set(['$400,000', '$500,000', '$450,000', '$750,000']));
  });

  it('keeps serving a legacy per-estimate narrative for old reports', async () => {
    const legacy = `Old narrative. ${NARRATIVE_FOOTER}`;
    const { service, communityNarratives } = makeService({
      narrative: legacy,
      narrativeGeneratedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrative).toBe(legacy);
    expect(result.narrativeSource).toBe('ai');
    expect(communityNarratives.findServable).not.toHaveBeenCalled();
  });

  it('never serves a pre-guard synthetic placeholder row', async () => {
    const { service } = makeService({
      narrative: 'This is a synthetic narrative placeholder (log provider).',
      narrativeGeneratedAt: NOW,
    });
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrative).toContain(COMMUNITY_TEXT);
  });

  it('serves the static guide for a community with no stored narrative', async () => {
    const { service, properties } = makeService({ inputs: SIZED_INPUTS });
    vi.mocked(properties.getProperty).mockResolvedValueOnce({ community: 'Brand New Place' } as never);
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrative).toBe(`${SENTENCE}\n\n${buildStaticGuideNarrative()}`);
    expect(result.narrativeSource).toBe('static-guide');
  });

  it('serves the static guide when the community is unknown or the lookup fails', async () => {
    const { service, properties } = makeService();
    vi.mocked(properties.getProperty).mockRejectedValueOnce(new Error('City down'));
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrativeSource).toBe('static-guide');
    expect(result.narrative).toContain(buildStaticGuideNarrative());
  });

  it('serves the static guide when the stored-narrative read fails', async () => {
    const { service, communityNarratives } = makeService();
    communityNarratives.findServable.mockRejectedValueOnce(new Error('db down'));
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrativeSource).toBe('static-guide');
  });

  it('describes renovations from the reno total', async () => {
    const { service } = makeService({
      projectType: 'renovation',
      figures: {
        build: { low: 0, base: 0, high: 0 },
        total: { low: 184000, base: 230000, high: 288000 },
        land: { value: 0 },
      },
    });
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrative.startsWith('For this renovation, our cost model puts the cost between $184,000 and $288,000')).toBe(true);
  });

  it('omits the sentence (no crash) for records without a single range', async () => {
    const { service } = makeService({ projectType: 'comparison' as never, figures: { rowSets: [] } });
    const result = await service.generateNarrative(TOKEN, ESTIMATE_ID);
    expect(result.narrative).toBe(COMMUNITY_TEXT);
  });

  it('rejects cross-user access with 403', async () => {
    const { service } = makeService();
    await expect(service.generateNarrative(OTHER_TOKEN, ESTIMATE_ID)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects invalid bearer token with 401', async () => {
    const { service } = makeService();
    await expect(service.generateNarrative(undefined, ESTIMATE_ID)).rejects.toMatchObject({ status: 401 });
    await expect(service.generateNarrative('nope', ESTIMATE_ID)).rejects.toMatchObject({ status: 401 });
  });

  it('returns 404 for an unknown or malformed estimate id', async () => {
    const { service } = makeService();
    await expect(
      service.generateNarrative(TOKEN, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.generateNarrative(TOKEN, 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
    await expect(service.generateNarrativeForAdmin('not-a-uuid')).rejects.toMatchObject({ status: 404 });
  });

  it('admin variant uses the same read path without a token', async () => {
    const { service } = makeService({ inputs: SIZED_INPUTS });
    const result = await service.generateNarrativeForAdmin(ESTIMATE_ID);
    expect(result.narrative).toBe(`${SENTENCE}\n\n${COMMUNITY_TEXT}`);
  });

  it('AC2: viewing 100 reports in one community makes zero LLM calls', async () => {
    const provider = makeProvider(COMMUNITY_TEXT);
    const spy = vi.spyOn(provider, 'generate');
    const stored = {
      communitySlug: 'beltline',
      period: '2026-09',
      narrative: COMMUNITY_TEXT,
      model: 'm',
      promptVersion: 'community-v1',
      status: 'succeeded' as const,
      attempts: 1,
      lastError: null,
      generatedAt: new Date('2026-08-31T09:00:00Z'),
      updatedAt: new Date('2026-08-31T09:00:00Z'),
    };
    const store = { findServable: vi.fn(async () => stored) } as unknown as CommunityNarrativeStore;
    const communityNarratives = createCommunityNarrativeService({
      store,
      provider,
      opsAlerts: { notifyFailure: vi.fn() },
      config: {
        enabled: true,
        runDay: 'last',
        retryDays: 3,
        promptVersion: 'community-v1',
        maxPerRun: 400,
        adminBudgetMs: 1000,
        tickBudgetMs: 1_200_000,
      },
      logEvent: () => {},
    });
    const stores = makeStores({ inputs: SIZED_INPUTS });
    const service = createNarrativeService({
      magicLinks: stores.magicLinks,
      leads: stores.leads,
      estimates: stores.estimates,
      properties: stores.properties,
      communityNarratives,
    });
    for (let i = 0; i < 100; i++) {
      const result = await service.generateNarrativeForAdmin(ESTIMATE_ID);
      expect(result.narrative).toContain(COMMUNITY_TEXT);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.findServable).toHaveBeenCalledTimes(100);
  });

  it('the static guide has no dollar figures and the footer exactly once', () => {
    const guide = buildStaticGuideNarrative();
    expect(guide).not.toMatch(/\$/);
    expect(guide.split(NARRATIVE_FOOTER).length - 1).toBe(1);
    expect(validateNarrative(guide, {
      costDataVersion: 'v', calibrated: false, rows: [],
      total: { low: 1, base: 1, high: 1 }, assumptions: [],
    }).ok).toBe(true);
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

  it('retries once with a higher token budget when the completion is truncated', async () => {
    const seenMaxTokens: number[] = [];
    let calls = 0;
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        seenMaxTokens.push(
          (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens,
        );
        const truncated = calls === 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: truncated
                    ? 'Cut off mid-senten'
                    : 'A complete neighbourhood summary.',
                },
                finish_reason: truncated ? 'length' : 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const result = await provider.generate({ system: 'System', user: 'User' });

    // First attempt at 800 tokens, one retry at 1600 — the truncated
    // first text is discarded, never returned.
    expect(calls).toBe(2);
    expect(seenMaxTokens).toEqual([800, 1600]);
    expect(result.text).toBe('A complete neighbourhood summary.');
    expect(result.model).toBe('test-model');
  });

  it('fails fast (no chain) when the truncation retry is also truncated', async () => {
    let calls = 0;
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['primary-model', 'backup-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: 'Always cut off mid-senten' },
                finish_reason: 'length',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const error = await provider
      .generate({ system: 'System', user: 'User' })
      .catch((e) => e);

    // One attempt + one retry on the primary model only — the backup
    // model is never tried (chaining would burn spend on the same
    // prompt), and the truncated text is never returned.
    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(NarrativeProviderError);
    expect(error.fatal).toBe(true);
    expect(error.message).toContain('truncated');
    expect(error.message).toContain('finish_reason=length');
  });

  it('treats an explicit finish_reason=stop as a normal success', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      targets: [{ label: 'test', apiKey: 'test-key', models: ['test-model'], endpoint: 'https://example.com/v1/chat/completions' }],
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: 'A finished summary.' },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });

    const result = await provider.generate({ system: 'System', user: 'User' });

    expect(result.text).toBe('A finished summary.');
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
            models: ['openai/gpt-oss-120b'],
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
        'openai/gpt-oss-120b',
      ]);
      expect(result.text).toBe('Groq fallback prose.');
      expect(result.model).toBe('openai/gpt-oss-120b');
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

      expect(result.model).toBe('openai/gpt-oss-120b');
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

