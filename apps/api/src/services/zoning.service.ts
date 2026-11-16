/**
 * Zoning rules catalogue service (#687).
 *
 * Serves the configured city's catalogue from `@feasly/zoning` — a pure,
 * versioned data package. The resolver drops every unverified value, so
 * what this returns is safe to show as-is ("typically allowed, confirm with
 * the City", with `sourceUrl`). No I/O, no db, no process.env (config
 * arrives via deps). No dollar figures: those only come from the cost engine.
 *
 * #689: the response also lists `estimableBuildingForms` — the forms the cost
 * engine can price today — so clients never hard-code which forms are
 * estimable. The list comes from the engine, never from the catalogue.
 */
import { BUILDING_FORMS, type BuildingForm, type ZoningDistrictsResponse } from '@feasly/contracts';
import { PRICED_BUILDING_FORMS } from '@feasly/cost-engine';
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
  const source = resolver.catalogue(city);
  const estimableBuildingForms: readonly BuildingForm[] = BUILDING_FORMS.filter((f) =>
    PRICED_BUILDING_FORMS.includes(f),
  );
  const catalogue: ZoningDistrictsResponse | undefined = source
    ? { ...source, estimableBuildingForms }
    : undefined;
  return {
    getCatalogue: () => catalogue,
    resolve: (districtCode, lot) => resolver.resolve(city, districtCode, lot),
  };
}
