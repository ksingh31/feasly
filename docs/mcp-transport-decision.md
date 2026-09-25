# MCP transport decision (APIMCP-05 spike)

**Date:** 2026-09-25 · **Status:** decided · **Spec pinned:** 2025-11-25
(verified against the live spec changelog; 2026-07-28 revision exists but the
TypeScript SDK v2 line targeting it is still beta)

## Decision

Feasly's MCP server uses exactly two transports:

1. **stdio** — local tooling (MCP Inspector, Claude Code local configs,
   developer machines). Entry: `packages/mcp/dist/stdio.js`.
2. **Streamable HTTP** — remote access, mounted at **`POST /mcp/v1`** on the
   existing Function App. No new Azure resource.

## Why Streamable HTTP, not SSE

The legacy HTTP+SSE transport (spec 2024-11-05, separate `/sse` + `/message`
endpoints) was **replaced by Streamable HTTP in spec 2025-03-26** and is
formally lifecycle-Deprecated as of 2026-07-28. Streamable HTTP is a strict
capability superset: one endpoint, one-shot JSON for cheap calls, optional
SSE upgrade for streaming, session via the `Mcp-Session-Id` header,
resumability via `Last-Event-ID`, explicit `DELETE` teardown. New servers
should not implement the deprecated transport; clients (Mastra, Claude Code,
etc.) already try Streamable HTTP first.

## Auth reuse

- **Bearer API key** (the api-mcp/01 issuance + middleware), checked before
  the transport handles the request — 401 JSON-RPC error without it.
- **Per-tool scope checks** (`property:read` / `estimate` / `lead`) inside
  the tool handlers, same scope model as REST.
- Full auth wiring lands with api-mcp/01; the spike prototyped the seam
  with a stub bearer check (missing key → 401, verified).

## Azure Functions fit (verified in prototype)

- **Stateless mode** (`sessionIdGenerator: undefined`): the Function App is
  stateless per-invocation and scales out, so in-memory session state would
  not survive. Stateless Streamable HTTP keeps every request self-contained.
- **No new paid Azure resource:** the endpoint mounts as one more HTTP
  trigger function on the existing Function App (same bundle pattern as
  `estimate/`, `leads/`).
- **DNS-rebinding protection:** the SDK transport validates the `Origin`
  header; the Function App's allowed origins must include the embed/consumer
  frontends. Misconfigured origins fail closed (403), never open.

## Verified in the spike (throwaway prototype, not merged)

SDK `@modelcontextprotocol/sdk@1.30.1` (v1.x production line):

- stdio: Inspector-style client lists tools and calls a test tool → correct result.
- `POST /mcp/v1` (stateless): client lists tools and calls a test tool → correct result.
- `POST /mcp/v1` without `Authorization: Bearer` → 401.
- Prototype code lives outside the repo (`/tmp`, deleted after the spike);
  only this decision doc is merged.

## Deviations / flags for Karan

1. **Spec's authorization direction:** since spec 2025-06-18, MCP classifies
   servers as OAuth 2.1 Resource Servers (RFC 8707 audience-bound tokens,
   protected-resource metadata). We deliberately choose **API-key Bearer
   for v1** — it matches the REST API's auth model (api-mcp/01) and is
   proportionate for a 3-tool server. Revisit OAuth if enterprise SSO
   demand appears; the transport choice is unaffected either way.
2. **npm publish:** whether `@feasly/mcp` is published at launch is still
   Karan's call (default: private until the embed business validates —
   see api-mcp/06 placeholders).
3. **Spec drift:** if the SDK v2 line (spec 2026-07-28) goes stable, the
   `subscriptions/listen` change does not affect our 3 stateless tools;
   no action needed now.
