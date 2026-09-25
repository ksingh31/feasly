/**
 * Admin estimate-lookup service (admin/03).
 *
 * Read-only: Karan pastes an estimate ID and sees exactly what the homeowner
 * saw — inputs, ranges, cost-data version, snapshot history. There is no
 * mutation method here by design (AC3); the HTTP layer only binds GET.
 *
 * Snapshot timeline (AC4): estimates are immutable — a re-estimate inserts a
 * new row and the consumer/02 dedupe rewrites the lead's `estimate_id` to
 * the newest. The timeline is therefore every estimate sharing the looked-up
 * estimate's `addressKey`, newest first. The linked lead identifies the
 * household (email); when the gate hasn't completed there is no lead and the
 * timeline is just the address's estimates.
 */
import { z } from 'zod';
import type { AdminEstimateDetail } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';

export interface AdminEstimatesService {
  /**
   * Full read-only detail for an estimate. Throws HttpError(404,
   * ESTIMATE_NOT_FOUND) for unknown ids (AC2).
   */
  getEstimate(id: string): Promise<AdminEstimateDetail>;
}

export interface AdminEstimatesServiceDeps {
  readonly estimateStore: EstimateStore;
  readonly leadStore: LeadStore;
}

const costRangeSchema = z.object({
  low: z.number(),
  base: z.number(),
  high: z.number(),
});

const figuresSchema = z.object({
  build: costRangeSchema,
  total: costRangeSchema,
  land: z.object({ value: z.number() }),
});

const projectTypeSchema = z.enum(['new_build', 'renovation']);

function notFound(id: string): HttpError {
  return new HttpError(
    404,
    ErrorCodes.ESTIMATE_NOT_FOUND,
    `No estimate found for id '${id}'.`,
    false,
  );
}

export function createAdminEstimatesService(
  deps: AdminEstimatesServiceDeps,
): AdminEstimatesService {
  const { estimateStore, leadStore } = deps;

  return {
    async getEstimate(id: string): Promise<AdminEstimateDetail> {
      const estimate = await estimateStore.findById(id);
      if (!estimate) throw notFound(id);

      const projectType = projectTypeSchema.safeParse(estimate.projectType);
      if (!projectType.success) {
        throw new HttpError(
          500,
          ErrorCodes.INTERNAL_ERROR,
          'Estimate has an unrecognized project type.',
          false,
        );
      }
      const figures = figuresSchema.safeParse(estimate.figures);
      if (!figures.success) {
        throw new HttpError(
          500,
          ErrorCodes.INTERNAL_ERROR,
          'Estimate figures are corrupt.',
          false,
        );
      }

      const lead = await leadStore.findByEstimateId(id);
      const snapshots = await estimateStore.findByAddressKey(
        estimate.addressKey,
      );

      return {
        id: estimate.id,
        projectType: projectType.data,
        inputs: estimate.inputs as AdminEstimateDetail['inputs'],
        outputs: {
          buildRange: figures.data.build,
          totalRange: figures.data.total,
          landValue: figures.data.land,
        },
        rows: (estimate.rows as AdminEstimateDetail['rows'] | null) ?? [],
        costDataVersion: estimate.costDataVersion,
        // The backend stores no narrative — the report's narrative is
        // generated client-side. Never invent one here (AC5).
        narrative: null,
        createdAt: estimate.createdAt.toISOString(),
        linkedLeadId: lead ? lead.id : null,
        snapshots: snapshots.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
        })),
      };
    },
  };
}
