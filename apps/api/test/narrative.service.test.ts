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
    expect(provider.calls).toBe(0);
  });

  it('rejects narrative with invented dollar amounts', async () => {
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

    await expect(service.generateNarrative(TOKEN, ESTIMATE_ID)).rejects.toThrow();
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
      model: 'test-model',
      endpoint: 'https://example.com/v1/chat/completions',
    });
    const prompt: NarrativePrompt = {
      system: 'System',
      user: 'User',
    };
    await expect(provider.generate(prompt)).rejects.toThrow(/API key/);
  });

  it('does not leak API key in error messages', async () => {
    const provider = createOpenAiCompatibleNarrativeProvider({
      apiKey: 'secret-key-12345',
      model: 'test-model',
      endpoint: 'https://example.com/v1/chat/completions',
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
      createOpenAiCompatibleNarrativeProvider({ model: 'test-model' }),
    ).toThrow(/NARRATIVE_ENDPOINT is not configured/);
  });

  it('appends /chat/completions to a bare base URL', async () => {
    const seen: string[] = [];
    const provider = createOpenAiCompatibleNarrativeProvider({
      apiKey: 'test-key',
      model: 'gemini-2.5-flash',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
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
  it('never returns the log provider placeholder — empty narrative instead', async () => {
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
    expect(result.narrative).toBe('');
    expect(result.narrative).not.toContain('synthetic narrative placeholder');
    expect(result.cached).toBe(false);
    // Never persisted: the next read regenerates (or stays empty), it
    // never serves dev-speak from the row.
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

    expect(result.narrative).toBe('');
    expect(result.narrative).not.toContain('synthetic narrative placeholder');
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

    expect(result.narrative).toBe('');
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
