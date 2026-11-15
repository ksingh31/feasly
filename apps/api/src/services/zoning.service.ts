/**
 * Zoning rules catalogue service (#687).
 *
 * Serves the configured city's catalogue from `@feasly/zoning` — a pure,
 * versioned data package. The resolver drops every unverified value, so
 * what this returns is safe to show as-is ("typically allowed, confirm with
 * the City", with `sourceUrl`). No I/O, no db, no process.env (config
 * arrives via deps). No dollar figures: those only come from the cost engine.
 */
import type { ZoningDistrictsResponse } from '@feasly/contracts';
import {
  ZONING_CATALOGUES,
  createZoningResolver,
  type ZoningLot,
  type ZoningResolution,
  type ZoningResolver,
} from '@feasly/zoning';
import type { ZoningConfig } from '../config';

export interface ZoningService {
  /** The active catalogue for the configured city; undefined when none is registered. */
  getCatalogue(): ZoningDistrictsResponse | undefined;
  /** Resolve one district code (fail-open: unknown → status 'unknown'). */
  resolve(districtCode: string | null | undefined, lot?: ZoningLot): ZoningResolution;
}

export interface ZoningServiceDeps {
  readonly config: Pick<ZoningConfig, 'city'>;
  /** Defaults to every registered catalogue. Tests inject fixture cities. */
  readonly resolver?: ZoningResolver;
}

export function createZoningService(deps: ZoningServiceDeps): ZoningService {
  const resolver = deps.resolver ?? createZoningResolver(ZONING_CATALOGUES);
  const { city } = deps.config;
  // The catalogue is static per deploy: project it once.
  const catalogue = resolver.catalogue(city);
  return {
    getCatalogue: () => catalogue,
    resolve: (districtCode, lot) => resolver.resolve(city, districtCode, lot),
  };
}
