/**
 * Service interfaces for the MCP server (api-mcp/06).
 *
 * These are minimal structural interfaces — the concrete implementations
 * live in `apps/api/src/services/` and are wired in `composition.ts`.
 * The MCP package defines what it needs (dependency inversion); TypeScript's
 * structural typing matches the concrete services.
 *
 * The MCP server is a thin wrapper: it calls these services and returns
 * their results as JSON. It contains zero cost-math, zero business logic.
 */

/** Subset of PropertyService used by the get_property tool. */
export interface McpPropertyService {
  autocomplete(query: string): Promise<unknown>;
  getProperty(addressKey: string): Promise<unknown>;
}

/** Subset of EstimateService used by the estimate_project tool. */
export interface McpEstimateService {
  estimate(requestBody: unknown): Promise<unknown>;
}

/** Subset of LeadService used by the submit_lead tool. */
export interface McpLeadService {
  submitLead(requestBody: unknown): Promise<unknown>;
}

export interface McpServerDeps {
  readonly property: McpPropertyService;
  readonly estimate: McpEstimateService;
  readonly leads: McpLeadService;
}

/**
 * Auth context for the Streamable HTTP transport. When present, each tool
 * call is gated on its required scope. When absent (stdio local tooling),
 * scope checks are skipped — stdio is trusted local access.
 */
export interface McpAuthContext {
  readonly keyId: string;
  readonly scopes: readonly string[];
  readonly sandbox: boolean;
  readonly tenantId: string | null;
}

/** Per-tool scope requirements (api-mcp/01 scopes). */
export const TOOL_SCOPES = {
  get_property: 'property:read',
  estimate_project: 'estimate',
  submit_lead: 'lead',
} as const;

export type McpToolName = keyof typeof TOOL_SCOPES;
