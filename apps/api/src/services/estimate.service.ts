/**
 * Estimate service — the thin seam between the HTTP boundary and the
 * deterministic cost engine.
 *
 * Responsibilities (and nothing else):
 *  1. Validate the request shape with Zod (types, not domain bounds).
 *  2. Run the pure engine against the injected, versioned cost-data table.
 *  3. Map engine input errors to 400s; unexpected throws become generic
 *     500s via the BE0-003 pipeline — never leak internals.
 *
 * Domain bounds (min/max sqft, values, zoning length) live in the cost-data
 * file and are enforced by the engine itself, so calibration changes never
 * require a code change here. The engine output already carries the pinned
 * cost_data_version.
 */
import { z } from 'zod';
import {
  createEstimate,
  EngineInputError,
  type CostData,
  type EstimateResult,
} from '@feasly/cost-engine';
import { ErrorCodes, HttpError } from '../middleware/errors';

/**
 * Request shape validation. Only structural checks — the engine owns the
 * domain bounds (they ship with the calibration table).
 */
export const EstimateRequestSchema = z.object({
  property: z.object({
    assessedLandValue: z.number().int().positive(),
    lotSizeSqft: z.number().int().positive(),
    zoning: z.string().trim().min(1),
  }),
  scope: z.object({
    buildSqft: z.number().int().positive(),
    tier: z.enum(['standard', 'premium', 'luxury']),
  }),
});

export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;

export interface EstimateService {
  /**
   * Run an estimate on an untrusted request body. Rejects with HttpError(400)
   * for invalid input; resolves to the engine result (with costDataVersion).
   */
  estimate(requestBody: unknown): Promise<EstimateResult>;
}

export interface EstimateServiceDeps {
  /** Versioned calibration table — wired once in composition.ts. */
  readonly costData: CostData;
}

export function createEstimateService(deps: EstimateServiceDeps): EstimateService {
  return {
    async estimate(requestBody: unknown): Promise<EstimateResult> {
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
      try {
        return createEstimate(parsed.data, deps.costData);
      } catch (error) {
        if (error instanceof EngineInputError) {
          throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, error.message, false);
        }
        throw error;
      }
    },
  };
}
