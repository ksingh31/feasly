#!/usr/bin/env node
/**
 * Stdio transport entry point (api-mcp/06).
 *
 * For local tooling (MCP Inspector, Claude Desktop, etc.).
 * No auth — stdio is trusted local access.
 *
 * Usage:
 *   node packages/mcp/dist/stdio.js
 *
 * Note: stdio mode needs the services wired. In production, the services
 * require config (database, etc.). This entry is for local development
 * where the composition can be built from environment.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import type {
  McpEstimateService,
  McpLeadService,
  McpPropertyService,
} from './types.js';

// The services are wired by the host application. For stdio, we build a
// minimal composition from the environment. This is intentionally separate
// from the Function App's composition — stdio is a dev/local tool.
async function main(): Promise<void> {
  // Dynamic import to avoid loading the full API composition at module
  // scope (keeps the stdio entry light for Inspector).
  // The apps/api package must be built (`tsc -b`) before running stdio.
  // The module path is hidden from TypeScript via a variable (no type
  // checking on the dynamic import — the shape is asserted below).
  const apiDistPath = '../../../apps/api/dist/index.js';
  const apiModule = (await import(apiDistPath)) as {
    createComposition: () => {
      propertyService: unknown;
      estimateService: unknown;
      leadService: unknown;
    };
  };
  const app = apiModule.createComposition();

  const server = createMcpServer({
    deps: {
      property: app.propertyService as McpPropertyService,
      estimate: app.estimateService as McpEstimateService,
      leads: app.leadService as McpLeadService,
    },
    // No auth: stdio is trusted local access.
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP stdio server failed:', error);
  process.exit(1);
});
