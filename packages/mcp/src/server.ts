/**
 * MCP server factory (api-mcp/06).
 *
 * Creates an `McpServer` with the three Feasly tools registered.
 * Used by both transports:
 * - stdio (`src/stdio.ts`) — local tooling, no auth
 * - Streamable HTTP (`apps/api/src/functions/mcp.ts`) — Bearer API-key auth
 *
 * The server is a thin wrapper: tools call the shared backend services.
 * Zero cost-math, zero business logic here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  TOOL_DEFINITIONS,
  executeTool,
} from './tools.js';
import type {
  McpAuthContext,
  McpServerDeps,
} from './types.js';

export interface CreateMcpServerOptions {
  /** Service implementations (wired in apps/api composition.ts). */
  readonly deps: McpServerDeps;
  /**
   * Auth context for scope gating. Omit for stdio (trusted local access);
   * provide for Streamable HTTP (per-tool scope checks).
   */
  readonly auth?: McpAuthContext;
}

/**
 * Build the MCP server with Feasly tools. The caller connects it to a
 * transport (stdio or Streamable HTTP).
 */
export function createMcpServer(
  options: CreateMcpServerOptions,
): McpServer {
  const { deps, auth } = options;

  const server = new McpServer(
    {
      name: 'feasly',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        // Tool descriptions are defined in tools.ts and carry the
        // deterministic-math disclaimer ("calculated deterministically").
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await executeTool(deps, auth, tool.name, args);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          // MCP errors: never silent success. The message carries the
          // failure reason (validation, scope denial, service error).
          const message =
            error instanceof Error ? error.message : 'Tool execution failed.';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: message }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
