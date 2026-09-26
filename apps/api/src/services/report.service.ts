/**
 * Report snapshots (phase-2 wiring).
 *
 * The report page renders from an immutable snapshot, never from live
 * recomputation — a shared link re-renders exactly the same numbers
 * forever (standing product rule, 2026-09-26).
 *
 * - `getReport` resolves the token (consumer/02 magic-link semantics) and
 *   returns the latest snapshot for the newest estimate, lazily creating
 *   version 1 on first read from the persisted estimate + lead rows.
 * - `createRevision` applies a tier/sqft what-if through the same
 *   deterministic engine the estimate endpoint uses and appends version
 *   N+1. Old snapshots are never mutated.
 * - `comparison` estimates have no snapshots — the contract `ReportSnapshot`
 *   only models standard/reno report figures.
 *
 * Narrative timing: the narrative worker fills the estimate row
 * asynchronously after creation, so a version-1 snapshot may be stored
 * with an empty narrative. The first read that sees a non-empty estimate
 * narrative appends a new version carrying it (with `updatedAt` set) —
 * no silent in-place edits, ever.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createEstimate,
  createRenoEstimate,
  EngineInputError,
  type CostData,
  type CostRow as EngineCostRow,
  type EstimateResult,
  type RangedAmount,
  type RenoEstimateResult,
} from '@feasly/cost-engine';
import type {
  CostRange,
  CostRow,
  FixedFigure,
  ProjectType,
  ReportSnapshot,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EstimateRecord, EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import type { PropertyService } from './property.service';
import { resolveReportToken } from './report-context';
import type {
  NewReportSnapshot,
  ReportSnapshotRecord,
  ReportSnapshotStore,
} from './report-snapshot.store';

export interface ReportService {
  /**
   * Latest report snapshot for the token's lead. Unknown or expired tokens
   * → HttpError(404); comparison estimates → HttpError(400).
   */
  getReport(reportToken: string): Promise<ReportSnapshot>;
  /**
   * Apply a tier/sqft what-if on an untrusted request body and append a new
   * snapshot version. At least one of `tier`/`sqft` is required.
   */
  createRevision(reportToken: string, requestBody: unknown): Promise<ReportSnapshot>;
}

export interface ReportServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly estimates: EstimateStore;
  readonly snapshots: ReportSnapshotStore;
  readonly properties: PropertyService;
  /** Same pinned cost data the estimate endpoint uses. */
  readonly costData: CostData;
  /** Same draft-data gate as the estimate endpoint. */
  readonly allowDraftCostData: boolean;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

const TierRevisionRequestSchema = z
  .object({
    tier: z.enum(['standard', 'premium', 'luxury']).optional(),
    sqft: z.number().int().positive().max(20000).optional(),
  })
  .strict()
  .refine((data) => data.tier !== undefined || data.sqft !== undefined, {
    message: 'At least one of tier or sqft is required.',
  });

/** Shape this service itself persists for estimate inputs. */
const StoredInputsSchema = z.object({
  sqft: z.number().int().positive(),
  tier: z.enum(['standard', 'premium', 'luxury']),
  garage: z.enum(['none', 'double', 'triple']),
  basement: z.enum(['unfinished', 'finished']),
  renoInputs: z
    .object({
      renoType: z.enum(['extensive', 'addition', 'basement', 'combined']),
      renoSqft: z.number().int().positive(),
      tier: z.enum(['standard', 'premium', 'luxury']),
      underpinning: z.boolean(),
    })
    .optional(),
});

const StoredRangeSchema = z.object({
  low: z.number(),
  base: z.number(),
  high: z.number(),
});

const StoredRowsSchema = z.array(
  z.object({
    key: z.string(),
    label: z.string(),
    range: StoredRangeSchema,
  }),
);

type StoredInputs = z.infer<typeof StoredInputsSchema>;

function fail(message: string): never {
  // Persisted snapshots are written by this service; an unreadable row is
  // data corruption, not user error.
  throw new HttpError(500, ErrorCodes.INTERNAL_ERROR, message, true);
}

function readInputs(value: unknown): StoredInputs {
  const parsed = StoredInputsSchema.safeParse(value);
  if (!parsed.success) fail('Stored estimate inputs are unreadable.');
  return parsed.data;
}

function toCostRange(amount: RangedAmount): CostRange {
  return { low: amount.low, base: amount.base, high: amount.high };
}

function toContractRow(row: EngineCostRow): CostRow {
  return { key: row.key, label: row.label, range: toCostRange(row.range) };
}

function contractRows(value: unknown): CostRow[] {
  const parsed = StoredRowsSchema.safeParse(value);
  if (!parsed.success) fail('Stored cost rows are unreadable.');
  return parsed.data.map((row) => ({
    key: row.key,
    label: row.label,
    range: { low: row.range.low, base: row.range.base, high: row.range.high },
  }));
}

function toContract(record: ReportSnapshotRecord): ReportSnapshot {
  const inputs = readInputs(record.inputs);
  const buildRange = StoredRangeSchema.safeParse(record.buildRange);
  const totalRange = StoredRangeSchema.safeParse(record.totalRange);
  const landValue = z.object({ value: z.number() }).safeParse(record.landValue);
  if (!buildRange.success || !totalRange.success || !landValue.success) {
    fail('Stored snapshot figures are unreadable.');
  }
  return {
    snapshotId: record.id,
    estimateId: record.estimateId,
    leadId: record.leadId,
    inputs: {
      sqft: inputs.sqft,
      tier: inputs.tier,
      garage: inputs.garage,
      basement: inputs.basement,
    },
    buildRange: {
      low: buildRange.data.low,
      base: buildRange.data.base,
      high: buildRange.data.high,
    },
    totalRange: {
      low: totalRange.data.low,
      base: totalRange.data.base,
      high: totalRange.data.high,
    },
    landValue: { value: landValue.data.value },
    rows: contractRows(record.rows),
    narrative: record.narrative,
    preparedAt: record.preparedAt.toISOString(),
    version: record.version,
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : undefined,
    // Only 'new_build' | 'renovation' are ever persisted here (comparison
    // estimates are rejected in resolveEstimate before any snapshot exists).
    projectType: record.projectType as ProjectType,
    renoInputs: inputs.renoInputs
      ? {
          projectType: 'renovation' as const,
          renoType: inputs.renoInputs.renoType,
          renoSqft: inputs.renoInputs.renoSqft,
          tier: inputs.renoInputs.tier,
          underpinning: inputs.renoInputs.underpinning,
        }
      : undefined,
    assumptions: record.assumptions ? [...record.assumptions] : undefined,
  };
}

/** Map a fresh engine result onto the stored snapshot figure columns. */
function figuresFromNewBuild(result: EstimateResult): {
  buildRange: CostRange;
  totalRange: CostRange;
  landValue: FixedFigure;
  rows: CostRow[];
} {
  return {
    buildRange: toCostRange(result.totals.build),
    totalRange: toCostRange(result.totals.total),
    landValue: { value: result.totals.land.value },
    rows: result.rows.map(toContractRow),
  };
}

function figuresFromReno(result: RenoEstimateResult): {
  buildRange: CostRange;
  totalRange: CostRange;
  landValue: FixedFigure;
  rows: CostRow[];
} {
  // Renovation carries no land figure — build == total, land fixed zero.
  const range = toCostRange(result.total);
  return {
    buildRange: range,
    totalRange: range,
    landValue: { value: 0 },
    rows: result.rows.map(toContractRow),
  };
}

interface ResolvedEstimate {
  readonly estimate: EstimateRecord;
  readonly latest: ReportSnapshotRecord | null;
  /** The token owner's lead — the estimates table has no lead_id column. */
  readonly leadId: string;
}

export function createReportService(deps: ReportServiceDeps): ReportService {
  const clock = deps.clock ?? (() => new Date());

  async function resolveEstimate(reportToken: string): Promise<ResolvedEstimate> {
    const { estimateId, lead } = await resolveReportToken(
      { magicLinks: deps.magicLinks, leads: deps.leads, clock },
      reportToken,
    );
    const estimate = await deps.estimates.findById(estimateId);
    if (!estimate) {
      throw new HttpError(
        404,
        ErrorCodes.ESTIMATE_NOT_FOUND,
        'No estimate found for this report.',
        false,
      );
    }
    if (estimate.projectType === 'comparison') {
      // The contract ReportSnapshot only models standard/reno report
      // figures — comparison estimates have no snapshots.
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        "Reports are not available for projectType 'comparison'.",
        false,
      );
    }
    const latest = await deps.snapshots.findLatestByEstimateId(estimate.id);
    return { estimate, latest, leadId: lead.id };
  }

  /** Version-1 snapshot straight from the persisted estimate + lead rows. */
  function snapshotFromEstimate(
    estimate: EstimateRecord,
    leadId: string,
    version: number,
    updatedAt: Date | null,
  ): NewReportSnapshot {
    const inputs = readInputs(estimate.inputs);
    const projectType = estimate.projectType;
    const figures = figuresFromEstimateLike(estimate);
    return {
      id: randomUUID(),
      estimateId: estimate.id,
      leadId,
      inputs: {
        sqft: inputs.sqft,
        tier: inputs.tier,
        garage: inputs.garage,
        basement: inputs.basement,
        ...(inputs.renoInputs ? { renoInputs: inputs.renoInputs } : {}),
      },
      buildRange: figures.buildRange,
      totalRange: figures.totalRange,
      landValue: figures.landValue,
      rows: figures.rows,
      narrative: estimate.narrative ?? '',
      assumptions: estimate.assumptions,
      projectType,
      renoInputs: null,
      version,
      updatedAt,
    };
  }

  return {
    async getReport(reportToken: string): Promise<ReportSnapshot> {
      const { estimate, latest, leadId } = await resolveEstimate(reportToken);
      if (latest) {
        const estimateNarrative = estimate.narrative ?? '';
        if (latest.narrative === '' && estimateNarrative !== '') {
          // The async narrative worker landed after v1 was snapshotted:
          // append a new version carrying it (never edit v1 in place).
          const backfill: NewReportSnapshot = {
            ...snapshotFromEstimate(estimate, leadId, latest.version + 1, clock()),
            narrative: estimateNarrative,
          };
          const inserted = await deps.snapshots.insert(backfill);
          return toContract(inserted);
        }
        return toContract(latest);
      }
      const inserted = await deps.snapshots.insert(
        snapshotFromEstimate(estimate, leadId, 1, null),
      );
      return toContract(inserted);
    },

    async createRevision(
      reportToken: string,
      requestBody: unknown,
    ): Promise<ReportSnapshot> {
      const parsed = TierRevisionRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          parsed.error.issues[0]?.message ?? 'Invalid revision request.',
          false,
        );
      }
      const { tier, sqft } = parsed.data;
      const { estimate, latest, leadId } = await resolveEstimate(reportToken);
      const baseInputs = readInputs(
        latest ? latest.inputs : estimate.inputs,
      );
      const projectType = estimate.projectType;
      const now = clock();

      let inputs: StoredInputs;
      let figures: {
        buildRange: CostRange;
        totalRange: CostRange;
        landValue: FixedFigure;
        rows: CostRow[];
      };
      let assumptions: readonly string[] | null;

      try {
        if (projectType === 'renovation') {
          const reno = baseInputs.renoInputs;
          if (!reno) fail('Stored renovation inputs are missing.');
          const renoSqft = sqft ?? reno.renoSqft;
          const renoTier = tier ?? reno.tier;
          if (!deps.costData.calibrated && !deps.allowDraftCostData) {
            throw new HttpError(
              503,
              ErrorCodes.DEPENDENCY_UNAVAILABLE,
              'Renovation pricing is not calibrated yet.',
              false,
            );
          }
          const result = createRenoEstimate(
            {
              renoType: reno.renoType,
              renoSqft,
              tier: renoTier,
              underpinning: reno.underpinning,
            },
            deps.costData,
          );
          inputs = {
            ...baseInputs,
            sqft: renoSqft,
            tier: renoTier,
            renoInputs: { ...reno, renoSqft, tier: renoTier },
          };
          figures = figuresFromReno(result);
          assumptions = result.assumptions;
        } else {
          const buildSqft = sqft ?? baseInputs.sqft;
          const buildTier = tier ?? baseInputs.tier;
          const property = await deps.properties.getProperty(estimate.addressKey);
          const result = createEstimate(
            {
              property: {
                // PropertyRecord (City data) → engine input field names.
                assessedLandValue: property.assessedValue,
                lotSizeSqft: property.lotSqft,
                zoning: property.zoning,
              },
              scope: {
                buildSqft,
                tier: buildTier,
              },
            },
            deps.costData,
          );
          inputs = { ...baseInputs, sqft: buildSqft, tier: buildTier };
          figures = figuresFromNewBuild(result);
          assumptions = estimate.assumptions;
        }
      } catch (error) {
        if (error instanceof EngineInputError) {
          throw new HttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            error.message,
            false,
          );
        }
        throw error;
      }

      const inserted = await deps.snapshots.insert({
        id: randomUUID(),
        estimateId: estimate.id,
        leadId,
        inputs,
        buildRange: figures.buildRange,
        totalRange: figures.totalRange,
        landValue: figures.landValue,
        rows: figures.rows,
        // Narrative describes the project, not the what-if tier/sqft — the
        // estimate row stays the source of truth.
        narrative: estimate.narrative ?? latest?.narrative ?? '',
        assumptions,
        projectType,
        renoInputs: null,
        version: (latest?.version ?? 0) + 1,
        updatedAt: now,
      });
      return toContract(inserted);
    },
  };
}

/**
 * The persisted estimate row already holds the exact figure JSON the engine
 * produced — re-map it onto snapshot columns without recomputing.
 */
function figuresFromEstimateLike(estimate: EstimateRecord): {
  buildRange: CostRange;
  totalRange: CostRange;
  landValue: FixedFigure;
  rows: CostRow[];
} {
  const figures = z
    .object({
      build: StoredRangeSchema,
      total: StoredRangeSchema,
      land: z.object({ value: z.number() }),
    })
    .safeParse(estimate.figures);
  if (!figures.success) fail('Stored estimate figures are unreadable.');
  return {
    buildRange: {
      low: figures.data.build.low,
      base: figures.data.build.base,
      high: figures.data.build.high,
    },
    totalRange: {
      low: figures.data.total.low,
      base: figures.data.total.base,
      high: figures.data.total.high,
    },
    landValue: { value: figures.data.land.value },
    rows: contractRows(estimate.rows),
  };
}
