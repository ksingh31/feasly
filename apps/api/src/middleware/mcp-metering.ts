/**
 * MCP quota metering predicate (#738).
 *
 * The MCP endpoint receives protocol housekeeping (`initialize`,
 * `tools/list`, notifications) alongside real work. Only `tools/call`
 * counts against a key's daily/monthly quota, so an MCP client gets the
 * same number of useful calls as a REST client.
 */
/**
 * #738: true when the JSON-RPC payload (single message or batch) contains
 * a `tools/call` request. Unparseable bodies are metered — the cautious
 * default for anything that isn't recognisably housekeeping.
 */
export function isMeteredMcpBody(body: unknown): boolean {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return true;
    }
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) return true;
  return messages.some(
    (m) =>
      m === null ||
      typeof m !== 'object' ||
      (m as { method?: unknown }).method === 'tools/call',
  );
}

/**
 * #738 review: true when the payload is a JSON-RPC batch holding more than
 * one `tools/call`. The quota check and the usage row are per HTTP request,
 * so a batch would multiply a key's daily/monthly/per-minute ceilings by its
 * size. The MCP 2025-06-18 spec dropped batching, so the endpoint rejects
 * these (JSON-RPC -32600) instead of metering each call.
 */
export function hasMultipleToolCalls(body: unknown): boolean {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed)) return false;
  let calls = 0;
  for (const m of parsed) {
    if (m !== null && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call') {
      calls += 1;
      if (calls > 1) return true;
    }
  }
  return false;
}
