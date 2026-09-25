/**
 * @feasly/mcp — public surface.
 *
 * The MCP server is a thin wrapper over the shared backend services.
 * See `src/server.ts` for the factory, `src/tools.ts` for the tool
 * definitions.
 */
export * from './types.js';
export * from './tools.js';
export { createMcpServer } from './server.js';
