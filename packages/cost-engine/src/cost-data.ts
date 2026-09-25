/**
 * Bundled calibration tables. The JSON files under ../cost-data/ are the
 * versioned, auditable source of every number the engine uses; this module
 * only loads and shape-checks them.
 *
 * Versioning rule: a data file is NEVER edited in place. A recalibration
 * ships as a new file (e.g. v0.2.0-calgary.json) so every historic estimate
 * stays reproducible via its pinned cost_data_version.
 */
import rawPlaceholder from '../cost-data/v0.3.0-unclibrated.json';
import type {
  ComparisonSpec,
  CostData,
  HardCostCategory,
  RenoSpec,
  SoftCostCategory,
} from './types';

const KNOWN_TIERS: readonly string[] = ['standard', 'premium', 'luxury'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isUnitFraction(value: unknown): value is number {
  return isNonNegativeNumber(value) && value < 1;
}

function checkTierRates(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  for (const tier of KNOWN_TIERS) {
    if (!isNonNegativeNumber(value[tier])) {
      throw new Error(`${path}.${tier}: expected a non-negative number`);
    }
  }
}

function checkHardCategory(value: unknown, path: string): asserts value is HardCostCategory {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  if (typeof value['label'] !== 'string' || value['label'].length === 0) {
    throw new Error(`${path}.label: expected a non-empty string`);
  }
  if (value['scalesWith'] !== 'buildSqft' && value['scalesWith'] !== 'lotSizeSqft') {
    throw new Error(`${path}.scalesWith: expected buildSqft|lotSizeSqft`);
  }
  if (typeof value['formula'] !== 'string' || value['formula'].length === 0) {
    throw new Error(`${path}.formula: expected a non-empty string`);
  }
  checkTierRates(value['rates'], `${path}.rates`);
  if (!isUnitFraction(value['spread'])) {
    throw new Error(`${path}.spread: expected a fraction in [0, 1)`);
  }
}

function checkSoftCategory(value: unknown, path: string): asserts value is SoftCostCategory {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  if (typeof value['label'] !== 'string' || value['label'].length === 0) {
    throw new Error(`${path}.label: expected a non-empty string`);
  }
  if (typeof value['formula'] !== 'string' || value['formula'].length === 0) {
    throw new Error(`${path}.formula: expected a non-empty string`);
  }
  if (!isUnitFraction(value['fraction']) || value['fraction'] === 0) {
    throw new Error(`${path}.fraction: expected a fraction in (0, 1)`);
  }
  if (!isUnitFraction(value['spread'])) {
    throw new Error(`${path}.spread: expected a fraction in [0, 1)`);
  }
}

function checkLabelAndFormula(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  if (typeof value['label'] !== 'string' || value['label'].length === 0) {
    throw new Error(`${path}.label: expected a non-empty string`);
  }
  if (typeof value['formula'] !== 'string' || value['formula'].length === 0) {
    throw new Error(`${path}.formula: expected a non-empty string`);
  }
}

const RENO_COMPONENTS: readonly string[] = ['extensive', 'addition', 'basement'];

/** Shape-check the renovation calibration section (RENO-01). */
function checkRenoSpec(value: unknown, path: string): asserts value is RenoSpec {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  if (typeof value['draft'] !== 'boolean') {
    throw new Error(`${path}.draft: expected a boolean`);
  }
  if (typeof value['draftNote'] !== 'string' || value['draftNote'].length === 0) {
    throw new Error(`${path}.draftNote: expected a non-empty string`);
  }
  const components = value['components'];
  if (!isRecord(components)) throw new Error(`${path}.components: expected an object`);
  for (const key of RENO_COMPONENTS) {
    const component = components[key];
    checkLabelAndFormula(component, `${path}.components.${key}`);
    checkTierRates(
      (component as Record<string, unknown>)['rates'],
      `${path}.components.${key}.rates`,
    );
  }
  if (!isNonNegativeNumber(value['additionCapSqft']) || value['additionCapSqft'] === 0) {
    throw new Error(`${path}.additionCapSqft: expected a positive number`);
  }
  const underpinning = value['underpinning'];
  checkLabelAndFormula(underpinning, `${path}.underpinning`);
  const u = underpinning as Record<string, unknown>;
  if (!isNonNegativeNumber(u['low']) || !isNonNegativeNumber(u['high'])) {
    throw new Error(`${path}.underpinning.low/high: expected non-negative numbers`);
  }
  if ((u['high'] as number) < (u['low'] as number)) {
    throw new Error(`${path}.underpinning: high must be >= low`);
  }
  // Asymmetric band factors: low = base × lowFactor (≤ 1), high = base × highFactor (≥ 1).
  const lowFactor = value['lowFactor'];
  if (!isNonNegativeNumber(lowFactor) || lowFactor === 0 || lowFactor > 1) {
    throw new Error(`${path}.lowFactor: expected a fraction in (0, 1]`);
  }
  if (
    !isNonNegativeNumber(value['highFactor']) ||
    (value['highFactor'] as number) < 1
  ) {
    throw new Error(`${path}.highFactor: expected a number >= 1`);
  }
  if (!Number.isInteger(value['roundTo']) || (value['roundTo'] as number) <= 0) {
    throw new Error(`${path}.roundTo: expected a positive integer`);
  }
  const bounds = value['inputBounds'];
  if (!isRecord(bounds)) throw new Error(`${path}.inputBounds: expected an object`);
  if (!isNonNegativeNumber(bounds['minRenoSqft']) || !isNonNegativeNumber(bounds['maxRenoSqft'])) {
    throw new Error(`${path}.inputBounds.minRenoSqft/maxRenoSqft: expected non-negative numbers`);
  }
  if ((bounds['minRenoSqft'] as number) > (bounds['maxRenoSqft'] as number)) {
    throw new Error(`${path}.inputBounds: minRenoSqft must be <= maxRenoSqft`);
  }
}

/** Shape-check the neighbourhood comparison section (NBH-02). */
function checkComparisonSpec(value: unknown, path: string): asserts value is ComparisonSpec {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  if (!isNonNegativeNumber(value['landRatePerSqft']) || value['landRatePerSqft'] === 0) {
    throw new Error(`${path}.landRatePerSqft: expected a positive number`);
  }
  if (!isUnitFraction(value['landSpread'])) {
    throw new Error(`${path}.landSpread: expected a fraction in [0, 1)`);
  }
}

/** Shape-check a parsed cost-data file; throws on the first problem. */
export function assertValidCostData(value: unknown): asserts value is CostData {
  if (!isRecord(value)) throw new Error('cost data: expected an object');
  if (typeof value['version'] !== 'string' || value['version'].length === 0) {
    throw new Error('cost data: version must be a non-empty string');
  }
  if (typeof value['calibrated'] !== 'boolean') {
    throw new Error('cost data: calibrated must be a boolean');
  }
  if (typeof value['source'] !== 'string' || typeof value['notes'] !== 'string') {
    throw new Error('cost data: source and notes must be strings');
  }
  if (!Array.isArray(value['tiers']) || value['tiers'].length === 0) {
    throw new Error('cost data: tiers must be a non-empty array');
  }
  for (const tier of value['tiers'] as unknown[]) {
    if (typeof tier !== 'string' || !KNOWN_TIERS.includes(tier)) {
      throw new Error(`cost data: unknown tier ${String(tier)}`);
    }
  }
  const bounds = value['inputBounds'];
  if (!isRecord(bounds)) throw new Error('cost data: inputBounds must be an object');
  for (const key of [
    'minBuildSqft',
    'maxBuildSqft',
    'minLotSizeSqft',
    'maxLotSizeSqft',
    'minAssessedLandValue',
    'maxAssessedLandValue',
    'maxZoningLength',
  ]) {
    if (!isNonNegativeNumber(bounds[key])) {
      throw new Error(`cost data: inputBounds.${key} must be a non-negative number`);
    }
  }
  if (!isRecord(value['hardCosts']) || Object.keys(value['hardCosts']).length === 0) {
    throw new Error('cost data: hardCosts must be a non-empty object');
  }
  for (const [key, category] of Object.entries(value['hardCosts'])) {
    checkHardCategory(category, `hardCosts.${key}`);
  }
  if (!isRecord(value['softCosts']) || Object.keys(value['softCosts']).length === 0) {
    throw new Error('cost data: softCosts must be a non-empty object');
  }
  for (const [key, category] of Object.entries(value['softCosts'])) {
    checkSoftCategory(category, `softCosts.${key}`);
  }
  const contingency = value['contingency'];
  if (!isRecord(contingency)) throw new Error('cost data: contingency must be an object');
  if (typeof contingency['label'] !== 'string' || contingency['label'].length === 0) {
    throw new Error('cost data: contingency.label must be a non-empty string');
  }
  if (typeof contingency['formula'] !== 'string' || contingency['formula'].length === 0) {
    throw new Error('cost data: contingency.formula must be a non-empty string');
  }
  if (!isUnitFraction(contingency['fraction'])) {
    throw new Error('cost data: contingency.fraction must be a fraction in [0, 1)');
  }
  if (!isUnitFraction(contingency['spread'])) {
    throw new Error('cost data: contingency.spread must be a fraction in [0, 1)');
  }
  if ('landSpread' in value) {
    throw new Error(
      'cost data: landSpread was removed — the assessed land value is now a fixed figure (see v0.2.0+)',
    );
  }
  checkRenoSpec(value['reno'], 'cost data.reno');
  checkComparisonSpec(value['comparison'], 'cost data.comparison');
}

const placeholder: unknown = rawPlaceholder;
assertValidCostData(placeholder);

/**
 * The bundled placeholder calibration table (v0.3.0-unclibrated,
 * calibrated: false). Stand-in numbers until Karan's real cost Sheet
 * arrives — see the file's _comment. Composition wires this in; the
 * engine itself only ever sees it as a CostData parameter.
 */
export const PLACEHOLDER_COST_DATA: CostData = placeholder;

/** Every bundled table version, for future multi-version support. */
export const BUNDLED_COST_DATA_VERSIONS: readonly string[] = [PLACEHOLDER_COST_DATA.version];
