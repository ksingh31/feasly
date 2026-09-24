# BE-7 — MCP server (agent API)

### BE7-001 — MCP server sharing the engine
**Size:** M
**Description:** `apps/mcp` (TypeScript, `@modelcontextprotocol/sdk`): exposes
`get_property`, `estimate_project`, `submit_lead` tools that call the SAME
`packages/engine` and the SAME service interfaces as the HTTP API — one engine,
three surfaces (web, REST, MCP). Versioned alongside `/api/v1`.
**Acceptance criteria:**
- MCP `estimate_project` output is byte-identical to the REST endpoint's for
  the same input (shared engine — test asserts).
- Tools validate inputs with the same zod schemas as the routes.
**Tests:** tool-level tests with stubbed services; parity test vs REST.
**Dependencies:** BE-2, BE-3.
