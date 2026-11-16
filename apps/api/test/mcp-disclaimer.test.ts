/**
 * #765 (go-live AC3): the deterministic-math disclaimer reaches every MCP
 * surface and every EstimateResponse.
 *
 * - tools/list over the real MCP route: every tool description carries
 *   ESTIMATE_DISCLAIMER verbatim.
 * - estimate_project over the real MCP route, backed by the REAL estimate
 *   service (engine + placeholder cost data, store faked at the interface):
 *   the tool result carries `disclaimer: ESTIMATE_DISCLAIMER`.
 * - Every EstimateResponse the service produces (new_build, renovation,
 *   sandbox) carries it.
 */
import { describe, expect, it, vi } from 'vitest';
import { ESTIMATE_DISCLAIMER } from '@feasly/contracts';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { createMcpRoute } from '../src/routes/mcp.route';
import { createEstimateService } from '../src/services/estimate.service';
import type { ApiKeyService } from '../src/services/api-key.service';
import type { PropertyService } from '../src/services/property.service';
import type { LeadService } from '../src/services/lead.service';
import type { EstimateRecord, EstimateStore } from '../src/services/estimate.store';
import { mockCommunityStatsService } from './helpers/mock-community-stats';

function fakeStore(): EstimateStore {
  const byId = new Map<string, EstimateRecord>();
  return {
    save: async (record) => {
      byId.set(record.id, record);
    },
    findById: async (id) => byId.get(id) ?? null,
    setNarrative: async () => false,
    findByAddressKey: async () => [],
  };
}

function realEstimateService() {
  return createEstimateService({
    costData: PLACEHOLDER_COST_DATA,
    store: fakeStore(),
    allowDraftCostData: true,
    communityStats: mockCommunityStatsService(),
  });
}

function keyRecord(sandbox: boolean) {
  return {
    id: 'key_1',
    name: 'Disclaimer key',
    tenantId: null,
    keyPrefix: sandbox ? 'feasly_test_…abcd' : 'feasly_live_…abcd',
    scopes: ['property:read', 'estimate', 'lead'],
    rateLimitPerMin: 100,
    sandbox,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-11-16T00:00:00Z'),
  };
}

function makeRoute(sandbox = false) {
  return createMcpRoute({
    apiKeys: {
      authenticate: vi.fn().mockResolvedValue(keyRecord(sandbox)),
    } as unknown as ApiKeyService,
    property: {
      autocomplete: vi.fn(),
      getProperty: vi.fn(),
    } as unknown as PropertyService,
    estimate: realEstimateService(),
    leads: { submitLead: vi.fn() } as unknown as LeadService,
  });
}

function parseSseBody(body: string): unknown {
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
  }
  throw new Error(`No data line in SSE body: ${body}`);
}

const AUTH = { authorization: 'Bearer feasly_live_ABC' };

const NEW_BUILD_ARGS = {
  projectType: 'new_build',
  property: {
    addressKey: 'calgary-123-fake-st-nw',
    assessedLandValue: 450_000,
    lotSizeSqft: 5_000,
    zoning: 'R-C1',
  },
  scope: { buildSqft: 2_200, tier: 'premium' },
};

describe('MCP disclaimer coverage (#765 AC3)', () => {
  it('tools/list: every tool description carries ESTIMATE_DISCLAIMER verbatim', async () => {
    const result = await makeRoute().handle(AUTH, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(result.status).toBe(200);
    const payload = parseSseBody(result.body as string) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(payload.result.tools.length).toBe(3);
    for (const tool of payload.result.tools) {
      expect(tool.description, tool.name).toContain(ESTIMATE_DISCLAIMER);
    }
  });

  it.each([
    ['live', false],
    ['sandbox', true],
  ] as const)(
    'estimate_project (%s key) returns an EstimateResponse carrying the disclaimer',
    async (_label, sandbox) => {
      const result = await makeRoute(sandbox).handle(AUTH, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'estimate_project', arguments: NEW_BUILD_ARGS },
      });
      expect(result.status).toBe(200);
      const payload = parseSseBody(result.body as string) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
      expect(payload.result.isError).not.toBe(true);
      const estimate = JSON.parse(payload.result.content[0]!.text) as {
        disclaimer: string;
        estimateId: string;
      };
      expect(estimate.estimateId).toBeTruthy();
      expect(estimate.disclaimer).toBe(ESTIMATE_DISCLAIMER);
    },
  );
});

describe('every EstimateResponse carries the disclaimer (#765 AC3)', () => {
  const RENO_BODY = {
    projectType: 'renovation',
    addressKey: 'calgary-456-reno-ave-nw',
    renoType: 'extensive',
    renoSqft: 1_000,
    tier: 'premium',
  };

  it.each([
    ['new_build', NEW_BUILD_ARGS, undefined],
    ['new_build (sandbox)', NEW_BUILD_ARGS, { sandbox: true }],
    ['renovation', RENO_BODY, undefined],
    ['renovation (sandbox)', RENO_BODY, { sandbox: true }],
  ] as const)('%s', async (_label, body, opts) => {
    const service = realEstimateService();
    const result = (await (opts
      ? service.estimate(body, opts)
      : service.estimate(body))) as { disclaimer?: string };
    expect(result.disclaimer).toBe(ESTIMATE_DISCLAIMER);
  });
});
