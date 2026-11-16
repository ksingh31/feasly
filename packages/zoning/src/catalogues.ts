/**
 * Registered zoning catalogues (issue #687). One entry per city version;
 * the API picks the city from `ZONING_CITY` config. Adding a city = a data
 * file in `./data/` + one line here + config — no resolver change.
 */
import type { ZoningRulesVersion } from '@feasly/contracts';
import { CALGARY_2026_08_04 } from './data/calgary-2026-08-04';

export const ZONING_CATALOGUES: readonly ZoningRulesVersion[] = [CALGARY_2026_08_04];
