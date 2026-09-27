/**
 * Postgres error-code helpers shared by the billing services.
 *
 * Drizzle surfaces driver errors wrapped ("Failed query: ..." with the pg
 * error as `cause`), so code checks must walk the `cause` chain.
 */

/**
 * True when the error is a Postgres unique-violation (SQLSTATE 23505).
 * Used to turn a lost check-then-act race into an idempotent "return the
 * existing row" instead of a 500:
 * - commission_invoices.attribution_id (migration 0033)
 * - attribution_events open (lead_id, tenant_key) (migration 0034)
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
