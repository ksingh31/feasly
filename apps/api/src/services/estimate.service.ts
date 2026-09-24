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
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createEstimate,
  EngineInputError,
  type CostData,
  type EngineInput,
  type EstimateResult,
  type RangedAmount,
} from '@feasly/cost-engine';
import type { CostRange, EstimateResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EstimateStore } from './estimate.store';

/**
 * Request shape validation. Only structural checks — the engine owns the
 * domain bounds (they ship with the calibration table). `garage`/`basement`
 * default for callers that don't collect them yet; they ride along in the
 * persisted inputs for future calibration.
 */
export const EstimateRequestSchema = z.object({
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

export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;

export interface EstimateService {
  /**
   * Run an estimate on an untrusted request body. Rejects with HttpError(400)
   * for invalid input; resolves to the contract `EstimateResponse`
   * (with pinned costDataVersion). Persisted before returning.
   */
  estimate(requestBody: unknown): Promise<EstimateResponse>;
}

export interface EstimateServiceDeps {
  /** Versioned calibration table — wired once in composition.ts. */
  readonly costData: CostData;
  /** Immutable estimate store — wired once in composition.ts. */
  readonly store: EstimateStore;
}

/** Engine bands are { low, base, high }; the contract carries all three. */
function toCostRange(band: RangedAmount): CostRange {
  return { low: band.low, base: band.base, high: band.high };
}

function toResponse(
  estimateId: string,
  parsed: EstimateRequest,
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
      land: toCostRange(result.totals.land),
    },
    rows: result.rows.map((row) => ({
      key: row.key,
      label: row.label,
      range: toCostRange(row.range),
    })),
    costDataVersion: result.costDataVersion,
    createdAt: createdAt.toISOString(),
  };
}

export function createEstimateService(deps: EstimateServiceDeps): EstimateService {
  return {
    async estimate(requestBody: unknown): Promise<EstimateResponse> {
      const parsed = EstimateRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first ? first.path.join('.') : 'body';
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Invalid estimate request at '${where}'.`,
          false,
        );
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
      const estimateId = randomUUID();
      const createdAt = new Date();
      const response = toResponse(estimateId, parsed.data, result, createdAt);
      await deps.store.save({
        id: estimateId,
        addressKey: response.addressKey,
        inputs: response.inputs,
        figures: response.figures,
        rows: response.rows,
        costDataVersion: response.costDataVersion,
        createdAt,
      });
      return response;
    },
  };
}
