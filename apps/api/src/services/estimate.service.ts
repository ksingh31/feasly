/**
 * Estimate service — the thin seam between the HTTP boundary and the
 * deterministic cost engine.
 *
 * Responsibilities (and nothing else):
 *  1. Validate the request shape with Zod (types, not domain bounds).
 *  2. Run the pure engine against the injected, versioned cost-data table.
 *  3. Persist the immutable estimate record (insert-only store).
 *  4. Map the engine result to the contracts `EstimateResponse` shape.
 *  5. Map engine input errors to 400s; unexpected throws become generic
 *     500s via the BE0-003 pipeline — never leak internals.
 *
 * Domain bounds (min/max sqft, values, zoning length) live in the cost-data
 * file and are enforced by the engine itself, so calibration changes never
 * require a code change here. The engine output already carries the pinned
 * cost_data_version.
 *
 * Note: the contract's `CostRange` is { low, base, high } — the engine's
 * deterministic base is exposed (not a client midpoint). Dollar figures stay
 * ranges; base is the model's best estimate within the range.
 *
 * Renovation (RENO-01): `projectType: 'renovation'` bodies route to the
 * engine's reno branch. Reno rates are uncalibrated draft placeholders, so
 * reno requests are refused (503) unless the cost table is calibrated or
 * COST_ENGINE_ALLOW_DRAFT is set — and production refuses to boot on draft
 * data at all (see composition.ts). New-build responses are byte-identical
 * to before: the reno-only fields (projectType, renoInputs, assumptions,
 * visibility) are populated on renovation responses only.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createComparisonEstimate,
  createEstimate,
  createRenoEstimate,
  EngineInputError,
  type ComparisonResult,
  type CostData,
  type EngineInput,
  type EstimateResult,
  type RangedAmount,
  type RenoEstimateResult,
  type RenoInput,
} from '@feasly/cost-engine';
import type {
  ComparisonEstimateResponse,
  CostRange,
  EstimateResponse,
  FixedFigure,
} from '@feasly/contracts';
import { ESTIMATE_DISCLAIMER } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { CommunityStatsService } from './community-stats.service';
import type { EstimateStore } from './estimate.store';

/**
 * Request shape validation. Only structural checks — the engine owns the
 * domain bounds (they ship with the calibration table). `garage`/`basement`
 * default for callers that don't collect them yet; they ride along in the
 * persisted inputs for future calibration.
 *
 * `projectType` is optional for backward compatibility: bodies without it
 * are new-build estimates (the M1 walking-skeleton shape).
 */
const NewBuildRequestSchema = z.object({
  projectType: z.literal('new_build').default('new_build'),
  property: z.object({
    addressKey: z.string().trim().min(1).max(200),
    assessedLandValue: z.number().int().positive(),
    lotSizeSqft: z.number().int().positive(),
    zoning: z.string().trim().min(1),
  }),
  scope: z.object({
    buildSqft: z.number().int().positive(),
    tier: z.enum(['standard', 'premium', 'luxury']),
    garage: z.enum(['none', 'double', 'triple']).default('none'),
    basement: z.enum(['unfinished', 'finished']).default('unfinished'),
  }),
});

/** Renovation request shape (RENO-01). `addressKey` is required. */
const RenoRequestSchema = z.object({
  projectType: z.literal('renovation'),
  addressKey: z.string().trim().min(1).max(200),
  renoType: z.enum(['extensive', 'addition', 'basement', 'combined']),
  renoSqft: z.number().int().positive(),
  tier: z.enum(['standard', 'premium', 'luxury']),
  underpinning: z.boolean().default(false),
});

/** Neighbourhood comparison request shape (NBH-02). */
const ComparisonRequestSchema = z.object({
  projectType: z.literal('comparison'),
  neighbourhoods: z.array(z.string().trim().min(1).max(100)).min(2).max(3),
  sqft: z.number().int().positive(),
  tier: z.enum(['standard', 'premium', 'luxury']),
});

export const EstimateRequestSchema = z.preprocess(
  (value) => {
    if (typeof value === 'object' && value !== null && !('projectType' in value)) {
      return { ...(value as Record<string, unknown>), projectType: 'new_build' };
    }
    return value;
  },
  z.discriminatedUnion('projectType', [
    NewBuildRequestSchema,
    RenoRequestSchema,
    ComparisonRequestSchema,
  ]),
);

export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;

export interface EstimateService {
  /**
   * Run an estimate on an untrusted request body. Rejects with HttpError(400)
   * for invalid input (RFC 7807 via the pipeline), 503 when renovation
   * estimates are disabled on uncalibrated data; resolves to the contract
   * `EstimateResponse` (with pinned costDataVersion), or
   * `ComparisonEstimateResponse` for projectType='comparison'. Persisted
   * before returning.
   */
  estimate(requestBody: unknown): Promise<EstimateResponse | ComparisonEstimateResponse>;
}

export interface EstimateServiceDeps {
  /** Versioned calibration table — wired once in composition.ts. */
  readonly costData: CostData;
  /** Immutable estimate store — wired once in composition.ts. */
  readonly store: EstimateStore;
  /**
   * Whether renovation estimates may run on uncalibrated draft tables
   * (COST_ENGINE_ALLOW_DRAFT). Wired from config in composition.ts.
   */
  readonly allowDraftCostData: boolean;
  /**
   * Community stats service (NBH-01) — for comparison land calculations.
   * Wired once in composition.ts.
   */
  readonly communityStats: CommunityStatsService;
}

/** Engine bands are { low, base, high }; the contract carries all three. */
function toCostRange(band: RangedAmount): CostRange {
  return { low: band.low, base: band.base, high: band.high };
}

function toResponse(
  estimateId: string,
  parsed: Extract<EstimateRequest, { projectType: 'new_build' }>,
  result: EstimateResult,
  createdAt: Date,
): EstimateResponse {
  return {
    estimateId,
    addressKey: parsed.property.addressKey,
    inputs: {
      sqft: parsed.scope.buildSqft,
      tier: parsed.scope.tier,
      garage: parsed.scope.garage,
      basement: parsed.scope.basement,
    },
    figures: {
      build: toCostRange(result.totals.build),
      total: toCostRange(result.totals.total),
      land: { value: result.totals.land.value },
    },
    rows: result.rows.map((row) => ({
      key: row.key,
      label: row.label,
      range: toCostRange(row.range),
    })),
    costDataVersion: result.costDataVersion,
    createdAt: createdAt.toISOString(),
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

/** Renovation estimates carry no land figure — fixed zero, never a range. */
const NO_LAND: FixedFigure = { value: 0 };

/**
 * Renovation response (RENO-01). Renovation carries no land figure — build
 * and total are the same reno range. `inputs` keeps the legacy shape for
 * type compatibility (sqft = reno area); `renoInputs` carries the precise
 * reno shape the future wizard UI consumes.
 */
function toRenoResponse(
  estimateId: string,
  parsed: Extract<EstimateRequest, { projectType: 'renovation' }>,
  result: RenoEstimateResult,
  createdAt: Date,
): EstimateResponse {
  const range = toCostRange(result.total);
  return {
    estimateId,
    addressKey: parsed.addressKey,
    projectType: 'renovation',
    inputs: {
      sqft: parsed.renoSqft,
      tier: parsed.tier,
      garage: 'none',
      basement: 'unfinished',
    },
    renoInputs: {
      projectType: 'renovation',
      renoType: parsed.renoType,
      renoSqft: parsed.renoSqft,
      tier: parsed.tier,
      underpinning: parsed.underpinning,
    },
    figures: {
      build: range,
      total: range,
      land: NO_LAND,
    },
    rows: result.rows.map((row) => ({
      key: row.key,
      label: row.label,
      range: toCostRange(row.range),
    })),
    assumptions: result.assumptions,
    visibility: { land: 'not_applicable', build: 'blurred', total: 'blurred' },
    costDataVersion: result.costDataVersion,
    createdAt: createdAt.toISOString(),
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

/**
 * Neighbourhood comparison response (NBH-02). One row-set per community
 * with land/build/total ranges and the lowest-land flag.
 */
function toComparisonResponse(
  estimateId: string,
  parsed: Extract<EstimateRequest, { projectType: 'comparison' }>,
  result: ComparisonResult,
  createdAt: Date,
): ComparisonEstimateResponse {
  return {
    estimateId,
    projectType: 'comparison',
    inputs: {
      sqft: parsed.sqft,
      tier: parsed.tier,
    },
    rowSets: result.rowSets.map((rs) => ({
      slug: rs.slug,
      lowestLand: rs.lowestLand,
      land: toCostRange(rs.land),
      build: toCostRange(rs.build),
      total: toCostRange(rs.total),
      visibility: rs.visibility,
    })),
    costDataVersion: result.costDataVersion,
    createdAt: createdAt.toISOString(),
  };
}

export function createEstimateService(deps: EstimateServiceDeps): EstimateService {
  return {
    async estimate(
      requestBody: unknown,
    ): Promise<EstimateResponse | ComparisonEstimateResponse> {
      const parsed = EstimateRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        // With a matched discriminator the issues carry the inner schema's
        // field paths (e.g. ['renoType']); with a bad/missing discriminator
        // they point at ['projectType'].
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? first.path.join('.') : 'body';

        // NBH-02: invalid neighbourhood count → 422 (not 400), naming the
        // 'neighbourhoods' field per the story's acceptance criteria.
        const isComparison =
          typeof requestBody === 'object' &&
          requestBody !== null &&
          (requestBody as Record<string, unknown>).projectType === 'comparison';
        const isNeighbourhoodsError =
          isComparison && first && first.path[0] === 'neighbourhoods';
        if (isNeighbourhoodsError) {
          throw new HttpError(
            422,
            ErrorCodes.VALIDATION_FAILED,
            `Invalid estimate request at 'neighbourhoods': must be 2–3 community slugs.`,
            false,
          );
        }

        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Invalid estimate request at '${where}'.`,
          false,
        );
      }

      const estimateId = randomUUID();
      const createdAt = new Date();

      if (parsed.data.projectType === 'renovation') {
        // Draft-data gate: reno rates are uncalibrated placeholders. Refuse
        // unless explicitly enabled (dev only — production never boots on
        // draft data, see composition.ts).
        if (!deps.costData.calibrated && !deps.allowDraftCostData) {
          throw new HttpError(
            503,
            ErrorCodes.DEPENDENCY_UNAVAILABLE,
            'Renovation estimates are not available yet.',
            false,
          );
        }
        const renoInput: RenoInput = {
          renoType: parsed.data.renoType,
          renoSqft: parsed.data.renoSqft,
          tier: parsed.data.tier,
          underpinning: parsed.data.underpinning,
        };
        let result: RenoEstimateResult;
        try {
          result = createRenoEstimate(renoInput, deps.costData);
        } catch (error) {
          if (error instanceof EngineInputError) {
            throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, error.message, false);
          }
          throw error;
        }
        const response = toRenoResponse(estimateId, parsed.data, result, createdAt);
        await deps.store.save({
          id: estimateId,
          projectType: 'renovation',
          addressKey: response.addressKey,
          inputs: { ...response.inputs, renoInputs: response.renoInputs },
          figures: response.figures,
          rows: response.rows,
          costDataVersion: response.costDataVersion,
          createdAt,
          narrative: null,
          narrativeGeneratedAt: null,
          assumptions: response.assumptions ?? null,
        });
        return response;
      }

      if (parsed.data.projectType === 'comparison') {
        // Neighbourhood comparison (NBH-02): look up each community's stats,
        // then run the comparison engine.
        const { neighbourhoods, sqft, tier } = parsed.data;

        // Fetch community stats for each slug.
        const avgLotSqftBySlug: Record<string, number | null> = {};
        for (const slug of neighbourhoods) {
          const stats = await deps.communityStats.getBySlug(slug);
          if (!stats) {
            throw new HttpError(
              422,
              ErrorCodes.COMMUNITY_NOT_FOUND,
              `Unknown community: '${slug}'.`,
              false,
            );
          }
          avgLotSqftBySlug[slug] = stats.avgLotSqft;
        }

        let result: ComparisonResult;
        try {
          result = createComparisonEstimate(
            {
              neighbourhoods,
              buildSqft: sqft,
              tier,
              avgLotSqftBySlug,
            },
            deps.costData,
          );
        } catch (error) {
          if (error instanceof EngineInputError) {
            // Map null-lot-size errors to COMMUNITY_NOT_FOUND (data incomplete),
            // other engine errors to VALIDATION_FAILED.
            const code = error.message.includes('no lot size data')
              ? ErrorCodes.COMMUNITY_NOT_FOUND
              : ErrorCodes.VALIDATION_FAILED;
            throw new HttpError(422, code, error.message, false);
          }
          throw error;
        }

        const response = toComparisonResponse(estimateId, parsed.data, result, createdAt);
        // Persist the immutable comparison record. addressKey is synthetic
        // (no single property); the neighbourhoods are in inputs.
        await deps.store.save({
          id: estimateId,
          projectType: 'comparison',
          addressKey: `comparison:${neighbourhoods.join('+')}`,
          inputs: response.inputs,
          figures: { rowSets: response.rowSets },
          rows: response.rowSets,
          costDataVersion: response.costDataVersion,
          createdAt,
          narrative: null,
          narrativeGeneratedAt: null,
          assumptions: null,
        });
        return response;
      }

      // The engine's input is the strict subset it understands; addressKey
      // and garage/basement travel in the persisted inputs, not the math.
      const engineInput: EngineInput = {
        property: {
          assessedLandValue: parsed.data.property.assessedLandValue,
          lotSizeSqft: parsed.data.property.lotSizeSqft,
          zoning: parsed.data.property.zoning,
        },
        scope: {
          buildSqft: parsed.data.scope.buildSqft,
          tier: parsed.data.scope.tier,
        },
      };
      let result: EstimateResult;
      try {
        result = createEstimate(engineInput, deps.costData);
      } catch (error) {
        if (error instanceof EngineInputError) {
          throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, error.message, false);
        }
        throw error;
      }
      const response = toResponse(estimateId, parsed.data, result, createdAt);
      await deps.store.save({
        id: estimateId,
        projectType: 'new_build',
        addressKey: response.addressKey,
        inputs: response.inputs,
        figures: response.figures,
        rows: response.rows,
        costDataVersion: response.costDataVersion,
        createdAt,
        narrative: null,
        narrativeGeneratedAt: null,
        assumptions: null,
      });
      return response;
    },
  };
}
