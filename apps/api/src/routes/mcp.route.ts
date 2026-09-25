/**
 * Thin MCP route (api-mcp/06).
 *
 * Routes are adapters, not logic: authenticate → create the MCP server →
 * handle the Streamable HTTP request → return the response.
 *
 * - POST /mcp/v1 — Streamable HTTP transport (stateless mode for the
 *   serverless Function App). Bearer API-key auth + per-tool scope checks.
 * - The MCP protocol handling (JSON-RPC, tool dispatch) lives in
 *   `@feasly/mcp` — this route only wires auth + services.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '@feasly/mcp';
import {
  authenticateApiKey,
  type ApiKeyAuthContext,
} from '../middleware/api-key-auth';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { ApiKeyService } from '../services/api-key.service';
import type { EstimateService } from '../services/estimate.service';
import type { LeadService } from '../services/lead.service';
import type { PropertyService } from '../services/property.service';

export interface McpRouteDeps {
  readonly apiKeys: ApiKeyService;
  readonly property: PropertyService;
  readonly estimate: EstimateService;
  readonly leads: LeadService;
}

export interface McpRoute {
  /**
   * Handle a Streamable HTTP MCP request.
   *
   * @param headers Request headers (for Bearer auth + correlation).
   * @param body Parsed JSON-RPC request body.
   * @returns The HTTP response (status, headers, body).
   */
  handle(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<{
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  }>;
}

export function createMcpRoute(deps: McpRouteDeps): McpRoute {
  return {
    handle: async (headers, body) => {
      // 1. Authenticate the API key (401 on failure).
      let auth: ApiKeyAuthContext;
      try {
        auth = await authenticateApiKey(headers, deps.apiKeys);
      } catch (error) {
        // authenticateApiKey throws HttpError(401) — convert to a plain
        // 401 response (the MCP client expects HTTP status, not RFC 7807).
        if (error instanceof HttpError && error.status === 401) {
          return {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
            body: {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32001,
                message: 'Invalid API key.',
              },
            },
          };
        }
        throw error;
      }

      // 2. Create the MCP server with the auth context (scope gating).
      const server = createMcpServer({
        deps: {
          property: deps.property,
          estimate: deps.estimate,
          leads: deps.leads,
        },
        auth: {
          keyId: auth.keyId,
          scopes: auth.scopes,
          sandbox: auth.sandbox,
          tenantId: auth.tenantId,
        },
      });

      // 3. Stateless transport (serverless: no session persistence).
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      try {
        await server.connect(transport);

        // 4. Build a Web Standard Request from the body.
        // The transport expects the parsed JSON-RPC message.
        const request = new Request('https://feasly.local/mcp/v1', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(body),
        });

        const response = await transport.handleRequest(request, {
          parsedBody: body,
        });

        // 5. Convert the Web Standard Response to the Function format.
        const responseBody = await response.text();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(responseBody);
        } catch {
          parsedBody = responseBody;
        }

        return {
          status: response.status,
          headers: responseHeaders,
          body: parsedBody,
        };
      } finally {
        await transport.close();
        await server.close();
      }
    },
  };
}

/** Error code for scope denial (MCP convention). */
export const MCP_SCOPE_DENIED_CODE = -32003;
