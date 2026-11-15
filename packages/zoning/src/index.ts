/**
 * @feasly/zoning — per-city, versioned zoning rules catalogue + pure resolver
 * (issue #687). Zero I/O, zero runtime deps, no dollar figures. See
 * docs/plan/CODING_PATTERNS.md §1 ("packages/zoning").
 */
export * from './resolver';
export { ZONING_CATALOGUES } from './catalogues';
export { CALGARY_2026_08_04 } from './data/calgary-2026-08-04';
