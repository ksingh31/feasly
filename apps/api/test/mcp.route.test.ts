/**
 * MCP route tests (api-mcp/06).
 *
 * Covers:
 * - Auth: missing/invalid Bearer <redacted> → 401 (MCP JSON-RPC error).
 * - Scope gating: tool call without the required scope → MCP error
 *   (never silent success).
 * - Happy path: valid key + scope → tool result.
 * - Fixture parity: MCP tool results deep-equal the REST service results.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMcpRoute } from '../src/routes/mcp.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { ApiKeyService } from '../src/services/api-key.service';
import type { PropertyService } from '../src/services/property.service';
import type { EstimateService } from '../src/services/estimate.service';
import type { LeadService } from '../src/services/lead.service';

const KEY_RECORD = {
  id: 'key_1',
  name: 'MCP Test Key',
  tenantId: null,
  keyPrefix: 'feasly_test_…abcd',
  scopes: ['property:read', 'estimate', 'lead'],
  rateLimitPerMin: 100,
  sandbox: true,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: new Date('2026-09-25T00:00:00Z'),
};

function makeApiKeyService(
  record: typeof KEY_RECORD | null,
): ApiKeyService {
  const authenticate = vi.fn();
  if (record) {
    authenticate.mockResolvedValue(record);
  } else {
    authenticate.mockRejectedValue(
      new HttpError(401, ErrorCodes.INVALID_API_KEY, 'Invalid API key.', false),
    );
  }
  return { authenticate } as unknown as ApiKeyService;
}

const PROPERTY_RECORD = {
  addressKey: '1600 90 AV SW',
  address: '1600 90 Av SW, Calgary, AB',
  community: 'BAYVIEW',
  lotSqft: 452960,
  zoning: 'C-C2',
  assessedValue: 60150000,
  assessmentYear: 2026,
};

function makePropertyService(): PropertyService {
  return {
    autocomplete: vi.fn().mockResolvedValue({ suggestions: [] }),
    getProperty: vi.fn().mockResolvedValue(PROPERTY_RECORD),
  } as unknown as PropertyService;
}

const ESTIMATE_RESULT = {
  estimateId: '123e4567-e89b-12d3-a456-426614174000',
  figures: { total: { low: 100000, base: 120000, high: 150000 } },
};

function makeEstimateService(): EstimateService {
  return {
    estimate: vi.fn().mockResolvedValue(ESTIMATE_RESULT),
  } as unknown as EstimateService;
}

const LEAD_RESULT = {
  leadId: '123e4567-e89b-12d3-a456-426614174001',
  email: 'test@example.com',
};

function makeLeadService(): LeadService {
  return {
    submitLead: vi.fn().mockResolvedValue(LEAD_RESULT),
  } as unknown as LeadService;
}

function makeRoute(scopes: string[] = ['property:read', 'estimate', 'lead']) {
  const apiKeys = makeApiKeyService({ ...KEY_RECORD, scopes });
  return createMcpRoute({
    apiKeys,
    property: makePropertyService(),
    estimate: makeEstimateService(),
    leads: makeLeadService(),
  });
}

/** Minimal JSON-RPC request for tools/call. */
function toolsCallRequest(toolName: string, args: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };
}

/** Parse an SSE body into the JSON-RPC payload. */
function parseSseBody(body: string): unknown {
  // Format: "event: message\ndata: {...}\n\n"
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error(`No data line in SSE body: ${body}`);
}

const AUTH_HEADERS = { authorization: 'Bearer feasly_test_ABC' };

describe('MCP route (api-mcp/06)', () => {
  it('rejects missing Bearer <redacted> 401 (MCP JSON-RPC error)', async () => {
    const route = makeRoute();
    const result = await route.handle(
      {},
      toolsCallRequest('get_property', { query: 'main' }),
    );

    expect(result.status).toBe(401);
    // Auth failures return a plain JSON-RPC error (not SSE).
    const payload = result.body as { error: { code: number } };
    expect(payload.error.code).toBe(-32001);
  });

  it('rejects invalid API key with 401', async () => {
    const route = createMcpRoute({
      apiKeys: makeApiKeyService(null),
      property: makePropertyService(),
      estimate: makeEstimateService(),
      leads: makeLeadService(),
    });

    const result = await route.handle(
      { authorization: 'Bearer invalid' },
      toolsCallRequest('get_property', { query: 'main' }),
    );

    expect(result.status).toBe(401);
  });

  it('tool call without the required scope → MCP error (never silent)', async () => {
    // Key has only property:read, but we call estimate_project.
    const route = makeRoute(['property:read']);

    const result = await route.handle(
      AUTH_HEADERS,
      toolsCallRequest('estimate_project', {
        projectType: 'new_build',
        property: {
          addressKey: 'x',
          assessedLandValue: 100000,
          lotSizeSqft: 5000,
          zoning: 'R-C1',
        },
        scope: { buildSqft: 2000, tier: 'standard' },
      }),
    );

    // The MCP protocol returns 200 with an isError result (not silent).
    expect(result.status).toBe(200);
    const payload = parseSseBody(result.body as string) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(payload.result.isError).toBe(true);
    const content = JSON.parse(payload.result.content[0]!.text);
    expect(content.error).toMatch(/lacks the required scope/);
  });

  it('get_property returns the service result (fixture parity)', async () => {
    const route = makeRoute();

    const result = await route.handle(
      AUTH_HEADERS,
      toolsCallRequest('get_property', { addressKey: '1600 90 AV SW' }),
    );

    expect(result.status).toBe(200);
    const payload = parseSseBody(result.body as string) as {
      result: { content: { text: string }[] };
    };
    const toolResult = JSON.parse(payload.result.content[0]!.text);
    // Deep-equal to the service result (same as REST).
    expect(toolResult).toEqual(PROPERTY_RECORD);
  });

  it('initialize handshake succeeds', async () => {
    const route = makeRoute();

    const result = await route.handle(AUTH_HEADERS, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });

    expect(result.status).toBe(200);
    const payload = parseSseBody(result.body as string) as {
      result: { serverInfo: { name: string } };
    };
    expect(payload.result.serverInfo.name).toBe('feasly');
  });

  it('tools/list returns the three tools', async () => {
    const route = makeRoute();

    const result = await route.handle(AUTH_HEADERS, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(result.status).toBe(200);
    const payload = parseSseBody(result.body as string) as {
      result: { tools: { name: string }[] };
    };
    const names = payload.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['estimate_project', 'get_property', 'submit_lead']);
  });
});
