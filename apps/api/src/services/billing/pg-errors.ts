/**
 * Backwards-compatible re-export: the helper now lives in
 * `services/pg-errors.ts` so non-billing services (builders) can use it
 * without importing through the billing directory.
 */
export { isUniqueViolation } from '../pg-errors';
