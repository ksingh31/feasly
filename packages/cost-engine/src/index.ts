/**
 * @feasly/cost-engine — deterministic build-cost engine.
 *
 * INVARIANTS (non-negotiable, see docs/plan/COST_ENGINE.md):
 * - Pure TypeScript: no I/O, no network, no filesystem, no Date.now(), no Math.random().
 * - Deterministic: identical inputs produce byte-identical outputs, every run.
 * - Zero runtime dependencies.
 * - NEVER imported by apps/web — the engine must not ship in the browser bundle.
 * - LLMs may narrate around engine outputs; they never produce dollar figures.
 */
export const COST_ENGINE_VERSION = '0.1.0';
