# @feasly/mcp

MCP server for Feasly (api-mcp/06). Exposes three tools that wrap the same
services and validation schemas as the REST API:

- `get_property` → `property:read` scope
- `estimate_project` → `estimate` scope
- `submit_lead` → `lead` scope

**Zero cost-math here.** All dollar figures come from the shared
`@feasly/cost-engine` via `EstimateService`. The MCP layer never computes
costs directly.

**Deterministic math disclaimer.** Every tool description states that figures
use deterministic math and makes no accuracy promises. Do not add accuracy
percentages to tool copy.

## Transports

### Stdio (local tooling)

For MCP Inspector, Claude Desktop, etc. No auth — stdio is trusted local access.

```bash
# Build both packages first
npm run build --workspace=@feasly/mcp
npm run build --workspace=@feasly/api

# Run the stdio server
node packages/mcp/dist/stdio.js
```

### Streamable HTTP (production)

Mounted at `POST /mcp/v1` in the Azure Functions app.

- **Auth:** `Authorization: Bearer <api-key>` (required)
- **Scopes:** enforced per-tool (`property:read`, `estimate`, `lead`)
- Missing scope → MCP error (`isError: true`), never silent success.

## MCP Inspector smoke-test steps

### Stdio transport

1. Build: `npm run build --workspace=@feasly/mcp && npm run build --workspace=@feasly/api`
2. Start Inspector: `npx @modelcontextprotocol/inspector`
3. In Inspector, set **Transport Type** to `STDIO`, **Command** to `node`,
   **Arguments** to `<repo>/packages/mcp/dist/stdio.js`.
4. Click **Connect**. The server should list three tools.
5. **Tools → List Tools**: verify `get_property`, `estimate_project`, `submit_lead`.
6. **get_property**: call with `{"query": "1600 90"}`. Verify autocomplete
   suggestions return.
7. **get_property**: call with `{"addressKey": "<key-from-step-6>"}`. Verify the
   full property record returns.
8. **estimate_project**: call with a `new_build` payload (see REST contract
   fixtures). Verify the estimate matches `POST /api/v1/estimate`.
9. **submit_lead**: call with `{"estimateId": "<id>", "email": "test@example.com",
   "idempotencyKey": "smoke-001"}`. Call twice with the same key — verify one
   lead row (check the `leads` table or the response `leadId` matches).

### Streamable HTTP transport

1. Get a test API key with scopes `property:read`, `estimate`, `lead`
   (see api-mcp/01 for key issuance).
2. Start Inspector: `npx @modelcontextprotocol/inspector`
3. In Inspector, set **Transport Type** to `Streamable HTTP`, **URL** to
   `http://localhost:7071/mcp/v1` (or the deployed Function App URL).
4. Add header: `Authorization: Bearer <test-key>`.
5. Click **Connect**. Verify the three tools list.
6. Repeat steps 5–9 from the stdio section above.
7. **Scope denial**: use a key with only `property:read`. Call `estimate_project`.
   Verify the result has `isError: true` and the error mentions the missing scope.
8. **Auth failure**: omit the `Authorization` header. Verify HTTP 401 with
   MCP error code `-32001`.

## Idempotency

`submit_lead` accepts an `idempotencyKey` tool argument. The key is stripped
before calling `LeadService`; dedupe matches REST (90-day window on email +
address). Same payload + key twice → one lead row.
