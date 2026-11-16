/**
 * Report narrative read path (consumer/06, reworked for #759).
 *
 * Owner decision 2026-11-15: no LLM call per estimate. The neighbourhood
 * narrative is generated once a month per community by the
 * community-narrative timer and stored; this service only READS it:
 *
 * authenticate (magic-link bearer) → load estimate → verify ownership →
 * - legacy: an estimate that already has a per-estimate narrative (from
 *   before #759) keeps serving it;
 * - otherwise: resolve the property's community → one DB read for the
 *   stored community narrative (newest month with text, so a failed month
 *   keeps last month's) → prepend the deterministic estimate sentence
 *   (size, finish, range — filled from the engine figures, no LLM);
 * - no stored narrative (new community, or none generated yet) → the
 *   deterministic sentence + the static Calgary guide.
 *
 * Nothing is persisted on the estimate row any more, and there is no
 * provider dependency at all — so viewing any number of reports costs zero
 * LLM calls. The estimate record is reconstructed into an `EstimateOutput`
 * from the persisted figures — the engine is NEVER re-run.
 */
import {
  buildEstimateSummary,
  type CostRow,
  type EstimateOutput,
  type RangedAmount,
} from '@feasly/cost-engine';
import type { NarrativeResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { CommunityNarrativeService } from './community-narrative.service';
import { toSlug } from './community-stats/socrata-aggregates';
import type { EstimateRecord, EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import { isSyntheticNarrative } from './narrative/narrative.types';
import { buildStaticGuideNarrative } from './narrative/static-guide';
import type { PropertyService } from './property.service';

export interface NarrativeService {
  /**
   * The report narrative for an estimate: stored community narrative +
   * deterministic estimate sentence (never an LLM call). Throws 401 (bad
   * token), 403 (not your estimate), 404 (unknown estimate).
   */
  generateNarrative(
    bearerToken: string | undefined,
    estimateId: string,
  ): Promise<NarrativeResponse>;
  /**
   * Admin variant of {@link generateNarrative}: same read path, but no
   * magic-link auth or ownership check — the caller (admin route) already
   * enforced the admin session guard. Throws 404 (unknown estimate).
   */
  generateNarrativeForAdmin(estimateId: string): Promise<NarrativeResponse>;
}

export interface NarrativeServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly estimates: EstimateStore;
  /** Property lookup for community resolution (best-effort). */
  readonly properties: Pick<PropertyService, 'getProperty'>;
  /** Stored monthly community narratives (#759) — read only. */
  readonly communityNarratives: Pick<CommunityNarrativeService, 'findServable'>;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reconstruct the engine output shape from the persisted record. */
function toEstimateOutput(record: EstimateRecord): EstimateOutput {
  const figures = record.figures as {
    build: { low: number; base: number; high: number };
    total: { low: number; base: number; high: number };
    land: { value: number };
  };
  const rows = record.rows as readonly CostRow[];
  const toRange = (r: { low: number; base: number; high: number }): RangedAmount => ({
    low: r.low,
    base: r.base,
    high: r.high,
  });
  if (record.projectType === 'renovation') {
    return {
      costDataVersion: record.costDataVersion,
      calibrated: false,
      rows,
      total: toRange(figures.total),
      assumptions: record.assumptions ?? [],
    };
  }
  return {
    costDataVersion: record.costDataVersion,
    calibrated: false,
    rows,
    totals: {
      build: toRange(figures.build),
      land: { value: figures.land.value },
      total: toRange(figures.total),
    },
  };
}

export function createNarrativeService(
  deps: NarrativeServiceDeps,
): NarrativeService {
  const clock = deps.clock ?? (() => new Date());

  /** The property's community slug, or undefined (best-effort). */
  async function communitySlugFor(record: EstimateRecord): Promise<string | undefined> {
    try {
      const property = await deps.properties.getProperty(record.addressKey);
      const name = property?.community?.trim();
      // PropertyService falls back to 'Calgary' when the City row has no
      // community — that means "unknown", not a community name.
      if (name && name.toLowerCase() !== 'calgary') return toSlug(name);
    } catch {
      // City data unavailable — degrade to the static guide.
    }
    return undefined;
  }

  /** Deterministic estimate sentence from engine figures; '' when not narratable. */
  function estimateSentence(record: EstimateRecord): string {
    try {
      const output = toEstimateOutput(record);
      const inputs = (record.inputs ?? {}) as { sqft?: unknown; tier?: unknown };
      const sqft = typeof inputs.sqft === 'number' ? inputs.sqft : null;
      const finishTier = typeof inputs.tier === 'string' ? inputs.tier : null;
      return buildEstimateSummary(output, {
        sqft: record.projectType === 'renovation' ? null : sqft,
        finishTier,
      });
    } catch {
      // Comparison or malformed records have no single range to describe.
      return '';
    }
  }

  function withSentence(sentence: string, narrative: string): string {
    return sentence ? `${sentence}\n\n${narrative}` : narrative;
  }

  async function narrativeForRecord(record: EstimateRecord): Promise<NarrativeResponse> {
    // Legacy per-estimate narrative (pre-#759 reports). Placeholder rows
    // persisted before the synthetic guard are never served.
    if (
      record.narrative &&
      record.narrativeGeneratedAt &&
      !isSyntheticNarrative(record.narrative)
    ) {
      return {
        estimateId: record.id,
        narrative: record.narrative,
        narrativeGeneratedAt: record.narrativeGeneratedAt.toISOString(),
        cached: true,
        narrativeSource: 'ai',
      };
    }
    const sentence = estimateSentence(record);
    const slug = await communitySlugFor(record);
    if (slug) {
      let stored = null;
      try {
        stored = await deps.communityNarratives.findServable(slug);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'narrative.community-read-failed',
            estimateId: record.id,
            error: error instanceof Error ? error.constructor.name : 'UnknownError',
          }),
        );
      }
      if (stored) {
        return {
          estimateId: record.id,
          narrative: withSentence(sentence, stored.narrative),
          narrativeGeneratedAt: stored.generatedAt.toISOString(),
          cached: true,
          narrativeSource: 'ai',
        };
      }
    }
    // No stored narrative for this community: the honest static guide.
    return {
      estimateId: record.id,
      narrative: withSentence(sentence, buildStaticGuideNarrative()),
      narrativeGeneratedAt: clock().toISOString(),
      cached: true,
      narrativeSource: 'static-guide',
    };
  }

  async function loadRecord(estimateId: string): Promise<EstimateRecord> {
    if (!UUID_RE.test(estimateId)) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Unknown estimate.', false);
    }
    let record;
    try {
      record = await deps.estimates.findById(estimateId);
    } catch (error) {
      throw new Error('estimate lookup failed', { cause: error });
    }
    if (!record) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Unknown estimate.', false);
    }
    return record;
  }

  async function authenticate(bearerToken: string | undefined): Promise<{
    leadId: string;
    estimateId: string;
  }> {
    const denied = new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'A valid bearer token is required.',
      false,
    );
    if (!bearerToken) throw denied;
    let link;
    try {
      link = await deps.magicLinks.findByToken(bearerToken);
    } catch (error) {
      throw new Error('magic link lookup failed', { cause: error });
    }
    const now = clock();
    if (!link || !link.leadId || link.revokedAt || link.expiresAt <= now) {
      throw denied;
    }
    let lead;
    try {
      lead = await deps.leads.findById(link.leadId);
    } catch (error) {
      throw new Error('lead lookup failed', { cause: error });
    }
    if (!lead) throw denied;
    return { leadId: lead.id, estimateId: lead.estimateId };
  }

  return {
    async generateNarrative(bearerToken, estimateId): Promise<NarrativeResponse> {
      if (!UUID_RE.test(estimateId)) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Unknown estimate.', false);
      }
      const auth = await authenticate(bearerToken);
      const record = await loadRecord(estimateId);
      // Ownership: the estimate must belong to the caller's lead. The 403
      // message names the reason, never the other party's data.
      if (record.id !== auth.estimateId) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This estimate belongs to a different user.',
          false,
        );
      }
      return narrativeForRecord(record);
    },
    /**
     * Admin entry point: same read path; the admin session guard (enforced
     * by the route) replaces magic-link auth.
     */
    async generateNarrativeForAdmin(estimateId: string): Promise<NarrativeResponse> {
      return narrativeForRecord(await loadRecord(estimateId));
    },
  };
}
