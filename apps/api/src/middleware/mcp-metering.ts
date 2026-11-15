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
