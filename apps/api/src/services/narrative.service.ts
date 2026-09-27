/**
 * AI narrative worker (story consumer/06).
 *
 * Generates the natural-language summary for an estimate's report page.
 * The LLM writes ONLY the narrative around the deterministic engine
 * figures — it never produces dollar figures. Two type-level and runtime
 * boundaries enforce this:
 *
 * 1. `buildNarrativePrompt()` (in @feasly/cost-engine) accepts ONLY the
 *    engine output — passing `CostData`/`CostParams` is a compile error.
 * 2. `validateNarrative()` rejects any output containing a $-figure not
 *    from the engine output, or missing the verbatim footer.
 *
 * Flow: authenticate (magic-link bearer) → load estimate → verify
 * ownership → return cached if present → rate-limit check → resolve
 * community context (property + community stats, best-effort) → build
 * prompt → provider.generate → validate → (one repair retry) → persist →
 * return. Validation failures fire the `narrative_worker_failed` ops
 * alert (defined in admin/06).
 *
 * Synthetic-output guard (bug goal_aec0b247775d): when the provider is the
 * log provider (no LLM key configured), its placeholder output is dropped
 * before validation/persistence — the response carries an empty narrative
 * and the report page renders its "summary unavailable" state. Placeholder
 * rows persisted before the guard are likewise never served from cache.
 *
 * The estimate record is reconstructed into an `EstimateOutput` from the
 * persisted figures/rows — the engine is NEVER re-run (the narrative
 * describes the historical snapshot, not a fresh computation).
 */
import {
  buildNarrativePrompt,
  validateNarrative,
  type CommunityFacts,
  type CostRow,
  type EstimateOutput,
  type NarrativePromptInput,
  type RangedAmount,
} from '@feasly/cost-engine';
import type { NarrativeResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { toSlug } from './community-stats/socrata-aggregates';
import type { CommunityStatsService } from './community-stats.service';
import type { EstimateRecord, EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import { isSyntheticNarrative } from './narrative/narrative.types';
import type {
  NarrativeProvider,
  NarrativeProviderResult,
} from './narrative/narrative.types';
import type { OpsAlertsService } from './ops-alerts.service';
import type { PropertyService } from './property.service';

export interface NarrativeService {
  /**
   * Generate (or return cached) the narrative for an estimate.
   * Throws 401 (bad token), 403 (not your estimate), 404 (unknown
   * estimate), 429 (rate-limited), 502 (provider/validation failure).
   */
  generateNarrative(
    bearerToken: string | undefined,
    estimateId: string,
  ): Promise<NarrativeResponse>;
}

export interface NarrativeServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly estimates: EstimateStore;
  readonly provider: NarrativeProvider;
  readonly opsAlerts: Pick<OpsAlertsService, 'notifyFailure'>;
  /** Property lookup for prompt community resolution (best-effort). */
  readonly properties: Pick<PropertyService, 'getProperty'>;
  /** Community stats for the prompt's neighbourhood section (best-effort). */
  readonly communityStats: Pick<CommunityStatsService, 'getBySlug'>;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
  /** Injected rate-limit store for tests; defaults to in-memory. */
  readonly rateLimitStore?: NarrativeRateLimitStore;
}

/** Minimal rate-limit store — production uses the shared throttler. */
export interface NarrativeRateLimitStore {
  /** Count generations for (estimateId) in the last 24h; record this one. */
  checkAndRecord(estimateId: string, now: Date): Promise<number>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cost guard: max LLM generations per estimate per 24h. */
const MAX_GENERATIONS_PER_DAY = 5;

/** In-memory rate-limit store (per-instance; tests inject a fake). */
function createMemoryRateLimitStore(): NarrativeRateLimitStore {
  const hits = new Map<string, number[]>();
  return {
    async checkAndRecord(estimateId: string, now: Date): Promise<number> {
      const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
      const times = (hits.get(estimateId) ?? []).filter((t) => t > cutoff);
      times.push(now.getTime());
      hits.set(estimateId, times);
      return times.length;
    },
  };
}

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

/** City facts for the prompt — city/province only, never PII. */
function cityFactsFor(record: EstimateRecord): NarrativePromptInput['cityFacts'] {
  // The addressKey is the normalized address; the community is not
  // reliably parseable from it, so only city/province are provided.
  // (The prompt builder handles missing community gracefully.)
  return { city: 'Calgary', province: 'Alberta' };
}

/** Aggregate vintage label for the prompt, e.g. "September 2026". */
function vintageLabel(d: Date): string {
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${month} ${d.getUTCFullYear()}`;
}

export function createNarrativeService(
  deps: NarrativeServiceDeps,
): NarrativeService {
  const clock = deps.clock ?? (() => new Date());
  const rateLimits = deps.rateLimitStore ?? createMemoryRateLimitStore();

  /**
   * Resolve community context for the narrative prompt. Best-effort: any
   * failure (City API down, unknown community, missing stats row) degrades
   * to city-only facts — narrative generation must never fail for this.
   */
  async function communityContextFor(record: EstimateRecord): Promise<{
    cityFacts: NarrativePromptInput['cityFacts'];
    communityFacts: CommunityFacts | undefined;
  }> {
    let community: string | undefined;
    try {
      const property = await deps.properties.getProperty(record.addressKey);
      const name = property?.community?.trim();
      // PropertyService falls back to 'Calgary' when the City row has no
      // community — that means "unknown", not a community name.
      if (name && name.toLowerCase() !== 'calgary') community = name;
    } catch {
      // City data unavailable — degrade to city-only facts.
    }
    let communityFacts: CommunityFacts | undefined;
    if (community) {
      try {
        const stats = await deps.communityStats.getBySlug(toSlug(community));
        communityFacts = {
          community: stats?.name ?? community,
          avgSingleFamilyAssessedValue: stats?.avgAssessedValue ?? null,
          assessedHomeCount: stats?.assessmentCount ?? null,
          avgLotSqft: stats?.avgLotSqft ?? null,
          dataVintage: stats ? vintageLabel(stats.refreshedAt) : null,
        };
      } catch {
        // Stats unavailable — the prompt still gets the community name so
        // the LLM covers the neighbourhood from its (hedged) knowledge.
        communityFacts = {
          community,
          avgSingleFamilyAssessedValue: null,
          assessedHomeCount: null,
          avgLotSqft: null,
          dataVintage: null,
        };
      }
    }
    return {
      cityFacts: community
        ? { city: 'Calgary', province: 'Alberta', community }
        : cityFactsFor(record),
      communityFacts,
    };
  }

  async function authenticate(bearerToken: string | undefined): Promise<{
    leadId: string;
    email: string;
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
    return { leadId: lead.id, email: lead.email, estimateId: lead.estimateId };
  }

  async function generateOnce(
    output: EstimateOutput,
    record: EstimateRecord,
  ): Promise<{
    result: NarrativeProviderResult;
    communityFacts: CommunityFacts | undefined;
  }> {
    const { cityFacts, communityFacts } = await communityContextFor(record);
    const input: NarrativePromptInput = {
      projectType:
        record.projectType === 'renovation' ? 'renovation' : 'new_build',
      estimate: output,
      cityFacts,
      communityFacts,
    };
    const prompt = buildNarrativePrompt(input);
    return {
      result: await deps.provider.generate(prompt),
      communityFacts,
    };
  }

  /**
   * Generate once; null when the provider emitted synthetic dev output.
   * Synthetic output (log provider — bug goal_aec0b247775d) is never
   * validated or persisted: callers return the empty-narrative response
   * instead, and the report page renders its "summary unavailable" state.
   * The marker-string check is a backstop in case a provider ever forgets
   * to set `synthetic: true`.
   */
  async function generateReal(
    output: EstimateOutput,
    record: EstimateRecord,
  ): Promise<{
    result: NarrativeProviderResult;
    communityFacts: CommunityFacts | undefined;
  } | null> {
    const generation = await generateOnce(output, record);
    if (deps.provider.synthetic || isSyntheticNarrative(generation.result.text)) {
      return null;
    }
    return generation;
  }

  return {
    async generateNarrative(
      bearerToken,
      estimateId,
    ): Promise<NarrativeResponse> {
      if (!UUID_RE.test(estimateId)) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Unknown estimate.',
          false,
        );
      }
      const auth = await authenticate(bearerToken);
      let record;
      try {
        record = await deps.estimates.findById(estimateId);
      } catch (error) {
        throw new Error('estimate lookup failed', { cause: error });
      }
      if (!record) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Unknown estimate.',
          false,
        );
      }
      // Ownership: the estimate must belong to the caller's lead. The
      // 403 message names the reason, never the other party's data.
      if (record.id !== auth.estimateId) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This estimate belongs to a different user.',
          false,
        );
      }
      // Cached: no LLM call, no cost. Placeholder rows persisted before the
      // synthetic guard (bug goal_aec0b247775d) are never served from cache.
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
        };
      }
      // Cost guard.
      const now = clock();
      let count: number;
      try {
        count = await rateLimits.checkAndRecord(estimateId, now);
      } catch (error) {
        throw new Error('rate limit check failed', { cause: error });
      }
      if (count > MAX_GENERATIONS_PER_DAY) {
        throw new HttpError(
          429,
          ErrorCodes.RATE_LIMITED,
          'Narrative generation rate limit exceeded. Try again tomorrow.',
          true,
        );
      }
      const output = toEstimateOutput(record);
      const fail = async (reason: string): Promise<never> => {
        try {
          await deps.opsAlerts.notifyFailure('narrative_worker_failed', {
            consecutiveFailures: 1,
            firstFailureAt: now,
          });
        } catch {
          // Alert delivery must never mask the original failure.
        }
        throw new HttpError(
          502,
          ErrorCodes.NARRATIVE_FAILED,
          `Narrative generation failed: ${reason}`,
          true,
        );
      };
      let result: NarrativeProviderResult;
      let communityFacts: CommunityFacts | undefined;
      // Synthetic dev output (log provider) never reaches users: the
      // report renders its "summary unavailable" state instead.
      const emptyForSynthetic = (): NarrativeResponse => ({
        estimateId: record.id,
        narrative: '',
        narrativeGeneratedAt: now.toISOString(),
        cached: false,
      });
      try {
        const generation = await generateReal(output, record);
        if (!generation) return emptyForSynthetic();
        result = generation.result;
        communityFacts = generation.communityFacts;
      } catch (error) {
        return fail(
          error instanceof Error ? error.message : 'provider error',
        );
      }
      let validation = validateNarrative(result.text, output, communityFacts);
      if (!validation.ok) {
        // One repair retry: ask the provider again (the prompt already
        // constrains the output; a second sample often fixes it).
        try {
          const retry = await generateReal(output, record);
          if (!retry) return emptyForSynthetic();
          result = retry.result;
          communityFacts = retry.communityFacts;
        } catch (error) {
          return fail(
            error instanceof Error ? error.message : 'provider error',
          );
        }
        validation = validateNarrative(result.text, output, communityFacts);
      }
      if (!validation.ok) {
        return fail(
          `LLM output failed validation: ${validation.violations.join('; ')}`,
        );
      }
      let persisted: boolean;
      try {
        persisted = await deps.estimates.setNarrative({
          id: record.id,
          narrative: result.text,
          generatedAt: now,
        });
      } catch (error) {
        throw new Error('narrative persistence failed', { cause: error });
      }
      // If a racing worker won, return the winner's narrative — unless it is
      // a pre-guard placeholder row, in which case this worker's (real,
      // already validated) result stands.
      if (!persisted) {
        const fresh = await deps.estimates.findById(record.id);
        if (
          fresh?.narrative &&
          fresh.narrativeGeneratedAt &&
          !isSyntheticNarrative(fresh.narrative)
        ) {
          return {
            estimateId: fresh.id,
            narrative: fresh.narrative,
            narrativeGeneratedAt: fresh.narrativeGeneratedAt.toISOString(),
            cached: true,
          };
        }
      }
      return {
        estimateId: record.id,
        narrative: result.text,
        narrativeGeneratedAt: now.toISOString(),
        cached: false,
      };
    },
  };
}
