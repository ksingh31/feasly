/**
 * MCP package tests (api-mcp/06).
 *
 * - Tool definitions carry the deterministic-math disclaimer, no accuracy promises.
 * - Scope denial throws (never silent success).
 * - Package has zero cost-math of its own.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOL_DEFINITIONS,
  requireToolScope,
  executeTool,
  GetPropertyInputSchema,
  SubmitLeadInputSchema,
} from '../src/tools.js';
import { TOOL_SCOPES } from '../src/types.js';
import type { McpServerDeps } from '../src/types.js';

describe('tool definitions', () => {
  it('exposes exactly three tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(names).toEqual(['estimate_project', 'get_property', 'submit_lead']);
  });

  it('every description carries the deterministic-math disclaimer', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description).toContain('deterministic');
    }
  });

  it('no description makes accuracy promises', () => {
    // Ban accuracy CLAIMS (e.g. "95% accurate", "guaranteed accurate").
    // The disclaimer "No accuracy percentage is claimed" is required, not banned.
    const banned = [/±\d+%/, /\d+%\s+accurate/i, /guarantee/i];
    for (const tool of TOOL_DEFINITIONS) {
      for (const pattern of banned) {
        expect(tool.description).not.toMatch(pattern);
      }
      // The disclaimer must explicitly disclaim accuracy.
      expect(tool.description).toMatch(/no accuracy/i);
    }
  });

  it('tool scopes match api-mcp/01 scopes', () => {
    expect(TOOL_SCOPES.get_property).toBe('property:read');
    expect(TOOL_SCOPES.estimate_project).toBe('estimate');
    expect(TOOL_SCOPES.submit_lead).toBe('lead');
  });
});

describe('requireToolScope', () => {
  it('passes when the key has the required scope', () => {
    const auth = {
      keyId: 'k1',
      scopes: ['property:read'],
      sandbox: false,
      tenantId: null,
    };
    expect(() => requireToolScope(auth, 'get_property')).not.toThrow();
  });

  it('throws when the key lacks the required scope (never silent)', () => {
    const auth = {
      keyId: 'k1',
      scopes: ['property:read'], // missing 'estimate'
      sandbox: false,
      tenantId: null,
    };
    expect(() => requireToolScope(auth, 'estimate_project')).toThrow(
      /lacks the required scope/,
    );
  });

  it('skips the check when no auth context (stdio local tooling)', () => {
    expect(() => requireToolScope(undefined, 'submit_lead')).not.toThrow();
  });
});

describe('executeTool', () => {
  const deps: McpServerDeps = {
    property: {
      autocomplete: vi.fn().mockResolvedValue({ suggestions: [] }),
      getProperty: vi.fn().mockResolvedValue({ addressKey: 'x' }),
    },
    estimate: {
      estimate: vi.fn().mockResolvedValue({ estimateId: 'e1' }),
    },
    leads: {
      submitLead: vi.fn().mockResolvedValue({ leadId: 'l1' }),
    },
  };

  const auth = {
    keyId: 'k1',
    scopes: ['property:read', 'estimate', 'lead'],
    sandbox: false,
    tenantId: null,
  };

  it('get_property with addressKey calls getProperty', async () => {
    const result = await executeTool(deps, auth, 'get_property', {
      addressKey: '123-main-st',
    });
    expect(deps.property.getProperty).toHaveBeenCalledWith('123-main-st');
    expect(result).toEqual({ addressKey: 'x' });
  });

  it('get_property with query calls autocomplete', async () => {
    const result = await executeTool(deps, auth, 'get_property', {
      query: 'main',
    });
    expect(deps.property.autocomplete).toHaveBeenCalledWith('main');
    expect(result).toEqual({ suggestions: [] });
  });

  it('get_property without addressKey or query throws', async () => {
    await expect(
      executeTool(deps, auth, 'get_property', {}),
    ).rejects.toThrow(/addressKey or query/);
  });

  it('scope denial throws (never silent success)', async () => {
    const limitedAuth = { ...auth, scopes: ['property:read'] };
    await expect(
      executeTool(deps, limitedAuth, 'estimate_project', {
        projectType: 'new_build',
        property: {
          addressKey: 'x',
          assessedLandValue: 100000,
          lotSizeSqft: 5000,
          zoning: 'R-C1',
        },
        scope: { buildSqft: 2000, tier: 'standard' },
      }),
    ).rejects.toThrow(/lacks the required scope/);
    // The service was never called.
    expect(deps.estimate.estimate).not.toHaveBeenCalled();
  });

  it('unknown tool throws', async () => {
    await expect(
      executeTool(deps, auth, 'delete_everything', {}),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('submit_lead strips the idempotency key before calling the service', async () => {
    const input = {
      estimateId: '123e4567-e89b-12d3-a456-426614174000',
      email: 'test@example.com',
      idempotencyKey: 'key-123',
    };
    await executeTool(deps, auth, 'submit_lead', input);
    // The service receives the body without the idempotency key.
    expect(deps.leads.submitLead).toHaveBeenCalledWith({
      estimateId: input.estimateId,
      email: input.email,
    });
  });
});

describe('input schemas', () => {
  it('get_property requires addressKey or query (validated at execution)', () => {
    // Empty object passes schema (both optional) — the handler enforces
    // that at least one is present.
    expect(() => GetPropertyInputSchema.parse({})).not.toThrow();
  });

  it('submit_lead requires a valid estimateId and email', () => {
    expect(() =>
      SubmitLeadInputSchema.parse({
        estimateId: 'not-a-uuid',
        email: 'test@example.com',
      }),
    ).toThrow();
    expect(() =>
      SubmitLeadInputSchema.parse({
        estimateId: '123e4567-e89b-12d3-a456-426614174000',
        email: 'not-an-email',
      }),
    ).toThrow();
  });
});
