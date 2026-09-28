/**
 * HTTP middleware layer (BE0-003).
 *
 * - correlation: `x-correlation-id` propagation / generation
 * - errors: RFC 7807 ProblemDetails (also satisfying the ApiError contract),
 *   HttpError, mapping, guards
 * - rate-limit: in-memory fixed-window limiter (config-driven)
 * - pipeline: correlation → rate limit → handler → errors, framework-agnostic
 *   (BE-3's Functions trigger adapters drive it)
 * - cors: origin allowlist enforcement for the Functions adapters (HRD-01)
 * - permission-guard: auth/04 requirePermission + session tenant scoping
 *
 * Hard rule (enforced by test/boundaries.test.ts): middleware NEVER imports
 * from src/db/ — it operates on the request/response, never the database.
 */
export * from './correlation';
export * from './cors';
export * from './errors';
export * from './rate-limit';
export * from './pipeline';
export * from './api-key-auth';
export * from './admin-guard';
export * from './permission-guard';
export * from './enforce-route-permissions';
export * from './security-headers';
export * from './session-token';
