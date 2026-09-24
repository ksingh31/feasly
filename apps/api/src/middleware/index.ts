/**
 * HTTP middleware layer.
 *
 * BE0-001: intentionally empty. Lands here in later stories:
 * - BE0-003: errorHandler (RFC 7807 ProblemDetails), correlationId, rateLimit
 * - BE-4:    requireAuth, requireRole('builder' | 'admin')
 *
 * Hard rule (enforced by test/boundaries.test.ts): middleware NEVER imports
 * from src/db/ — it operates on the request/response, never the database.
 */
export {};
