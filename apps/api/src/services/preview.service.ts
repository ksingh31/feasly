/**
 * Pre-gate estimate preview (phase-2 wiring).
 *
 * Runs the SAME deterministic engine as the full estimate endpoint and
 * persists the full estimate row (the lead gate attaches to its
 * estimateId), but returns ONLY the `PreviewEstimateResponse` shape:
 * every figure is `{ blurred: true }` and rows is empty.
 *
 * Pre-gate blur is type-enforced: the contract types `figures` with
 * `BlurredFigure`, so assigning a real `CostRange` here is a compile
 * error, not a convention. The projection below is the only place the
 * full response is narrowed — nothing real can leak by construction.
 */
import type {
  ComparisonEstimateResponse,
  EstimateResponse,
  PreviewEstimateResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EstimateService } from './estimate.service';

export interface PreviewService {
  /**
   * Run a pre-gate preview on an untrusted request body. Rejects with
   * HttpError(400) for invalid input (same validation as the estimate
   * endpoint); resolves to the contract `PreviewEstimateResponse`.
   */
  preview(requestBody: unknown): Promise<PreviewEstimateResponse>;
}

export interface PreviewServiceDeps {
  /** The full estimate service — compute + persist, then narrow. */
  readonly estimates: EstimateService;
}

/**
 * The type-enforced narrowing. `figures` only accepts `BlurredFigure`;
 * `rows` only accepts the empty tuple — a real range or a real row here
 * fails compilation.
 */
function toPreview(response: EstimateResponse): PreviewEstimateResponse {
  return {
    estimateId: response.estimateId,
    addressKey: response.addressKey,
    inputs: response.inputs,
    figures: {
      build: { blurred: true },
      total: { blurred: true },
      land: { blurred: true },
    },
    rows: [],
    costDataVersion: response.costDataVersion,
    createdAt: response.createdAt,
  };
}

function isComparison(
  response: EstimateResponse | ComparisonEstimateResponse,
): response is ComparisonEstimateResponse {
  return (response as ComparisonEstimateResponse).projectType === 'comparison';
}

export function createPreviewService(deps: PreviewServiceDeps): PreviewService {
  return {
    async preview(requestBody: unknown): Promise<PreviewEstimateResponse> {
      const response = await deps.estimates.estimate(requestBody);
      if (isComparison(response)) {
        // The wizard preview is a new-build/renovation concept; comparison
        // estimates go straight to the full (post-gate-style) response.
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          "Pre-gate preview is not supported for projectType 'comparison'.",
          false,
        );
      }
      return toPreview(response);
    },
  };
}
