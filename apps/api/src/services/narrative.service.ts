/**
 * AI narrative worker (consumer/06) — `POST /api/v1/estimates/{id}/narrative`.
 *
 * Generates the report's natural-language summary around the deterministic
 * engine figures: loads the immutable estimate snapshot, builds the prompt
 * via `buildNarrativePrompt()` (the cost-engine boundary — CostData /
 * CostParams can never reach the prompt, compile-enforced), calls the LLM
 * through the `NarrativeProvider` interface, and validates the result with
 * `validateNarrative()` (rejects invented $-figures or a missing verbatim
 * footer). One repair retry; a second failure → 502 `NARRATIVE_FAILED` +
 * the `narrative_worker_failed` ops alert (admin/06).
 *
 * Safety properties:
 * - Magic-link bearer auth, uniform 401 — the endpoint is not a token oracle.
 * - Cross-user access → 403 + audit row.
 * - Validated narratives are cached on the estimate row; repeat calls never
 *   re-invoke the LLM (no extra cost).
 * - Cost guard: at most `maxGenerationsPerDay` LLM calls per estimate per
 *   trailing `generationWindowMs` → 429 `RATE_LIMITED` beyond that.
 * - The provider defaults to `log` (no network, no spend) until Karan
 *   provisions `META_API_KEY`.
 */
import {
  buildNarrativePrompt,
  validateNarrative,
  type CostRow,
  type EstimateOutput,
  type NarrativeProjectType,
  type NarrativePrompt,
  type NarrativePromptInput,
} from '@feasly/cost-engine';
import {
  ESTIMATE_DISCLAIMER,
  type CostRange,
  type EstimateInputs,
  type EstimateResponse,
  type RenoEstimateInputs,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EstimateRecord, EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import type { NarrativeGenerationStore } from './narrative.store';
import type { NarrativeProvider } from './narrative.provider';
import type { OpsAlertsService } from './ops-alerts.service';
import type { PrivacyStore } from './privacy.store';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** City facts for the prompt — Feasly is Calgary-only (standing rule). */
const NARRATIVE_CITY_FACTS = {
  city: 'Calgary',
  province: 'Alberta',
} as const;

export interface NarrativeServiceDeps {
  readonly estimates: EstimateStore;
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly generations: NarrativeGenerationStore;
  readonly provider: NarrativeProvider;
  readonly opsAlerts: Pick<OpsAlertsService, 'notifyFailure'>;
  /** PII-free audit trail (privacy_audit_log) — denial rows only. */
  readonly audit: Pick<PrivacyStore, 'audit'>;
  /** Cost guard: max LLM generations per estimate per window (default 5). */
  readonly maxGenerationsPerDay: number;
  /** Trailing window for the cost guard (default 24h). */
  readonly generationWindowMs: number;
  readonly clock?: () => Date;
}

export interface NarrativeService {
  /**
   * Generate (or return the cached) narrative for an estimate.
   * Throws HttpError: 401 unauthenticated, 403 cross-user, 404 unknown
   * estimate / unsupported type, 429 over the generation cost guard,
   * 502 narrative failed validation twice or the provider errored.
   */
  generateNarrative(
    bearerToken: string | undefined,
    estimateId: string,
  ): Promise<EstimateResponse>;
}

interface AuthContext {
  readonly leadId: string;
  readonly email: string;
}

export function createNarrativeService(
  deps: NarrativeServiceDeps,
): NarrativeService {
  const clock = deps.clock ?? (() => new Date());

  async function authenticate(
    bearerToken: string | undefined,
  ): Promise<AuthContext> {
    const denied = new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'A valid Bearer <redacted> is required.',
      false,
    );
    if (!bearerToken) {
      await deps.audit.audit({ leadId: null, action: 'narrative.denied' });
      throw denied;
    }
    let link;
    try {
      link = await deps.magicLinks.findByToken(bearerToken);
    } catch (error) {
      throw new Error('magic link lookup failed', { cause: error });
    }
    const now = clock();
    if (!link || !link.leadId || link.revokedAt || link.expiresAt <= now) {
      await deps.audit.audit({ leadId: null, action: 'narrative.denied' });
      throw denied;
    }
    let lead;
    try {
      lead = await deps.leads.findById(link.leadId);
    } catch (error) {
      throw new Error('lead lookup failed', { cause: error });
    }
    if (!lead) {
      await deps.audit.audit({ leadId: null, action: 'narrative.denied' });
      throw denied;
    }
    return { leadId: lead.id, email: lead.email };
  }

  /**
   * Rebuild the engine output the narrative describes from the persisted
   * snapshot. Renovation assumptions were not persisted historically, so
   * they narrate as absent — the figures (the validator's allow-list) are
   * always complete.
   */
  function toEstimateOutput(record: EstimateRecord): EstimateOutput {
    const rows = record.rows as readonly CostRow[];
    const figures = record.figures as {
      readonly build: CostRange;
      readonly total: CostRange;
      readonly land: { readonly value: number };
    };
    // costDataVersion 'v0.1.0-unclibrated' is the pre-calibration table —
    // the calibrated flag follows the version string, never a guess.
    const costDataVersion = record.costDataVersion;
    const calibrated = !costDataVersion.includes('uncalibrated');
    if (record.projectType === 'renovation') {
      return {
        costDataVersion,
        calibrated,
        rows,
        total: figures.total,
        assumptions: [],
      };
    }
    return {
      costDataVersion,
      calibrated,
      rows,
      totals: {
        build: figures.build,
        land: figures.land,
        total: figures.total,
      },
    };
  }

  /** Rebuild the contract response from the stored snapshot + narrative. */
  function toResponse(
    record: EstimateRecord,
    narrative: string,
    generatedAt: Date,
  ): EstimateResponse {
    const storedInputs = record.inputs as Record<string, unknown>;
    const response: EstimateResponse = {
      estimateId: record.id,
      addressKey: record.addressKey,
      inputs: {
        sqft: storedInputs['sqft'],
        tier: storedInputs['tier'],
        garage: storedInputs['garage'],
        basement: storedInputs['basement'],
      } as EstimateInputs,
      figures: record.figures as EstimateResponse['figures'],
      rows: record.rows as EstimateResponse['rows'],
      costDataVersion: record.costDataVersion,
      createdAt: record.createdAt.toISOString(),
      disclaimer: ESTIMATE_DISCLAIMER,
      narrative,
      narrativeGeneratedAt: generatedAt.toISOString(),
    };
    if (record.projectType === 'renovation') {
      return {
        ...response,
        projectType: 'renovation',
        renoInputs: storedInputs['renoInputs'] as RenoEstimateInputs,
      };
    }
    return response;
  }

  function buildPrompt(record: EstimateRecord): {
    readonly prompt: NarrativePrompt;
    readonly output: EstimateOutput;
  } {
    const output = toEstimateOutput(record);
    const input: NarrativePromptInput = {
      projectType: record.projectType as NarrativeProjectType,
      estimate: output,
      cityFacts: NARRATIVE_CITY_FACTS,
    };
    return { prompt: buildNarrativePrompt(input), output };
  }

  /** Second-attempt prompt: same rules + the exact violations to repair. */
  function buildRepairPrompt(
    prompt: NarrativePrompt,
    violations: readonly string[],
  ): NarrativePrompt {
    return {
      system: prompt.system,
      user:
        prompt.user +
        '\n\nYour previous response was rejected for these reasons:\n' +
        violations.map((v) => `- ${v}`).join('\n') +
        '\nRewrite the narrative fixing exactly these issues. ' +
        'Do not change any dollar figure.',
    };
  }

  async function failNarrative(): Promise<never> {
    const now = clock();
    await deps.opsAlerts.notifyFailure('narrative_worker_failed', {
      consecutiveFailures: 1,
      firstFailureAt: now,
    });
    // Generic public message — validator diagnostics never reach the
    // client (they stay in the provider/alert trail server-side).
    throw new HttpError(
      502,
      ErrorCodes.NARRATIVE_FAILED,
      'Narrative generation failed. Please try again later.',
    );
  }

  return {
    async generateNarrative(
      bearerToken: string | undefined,
      estimateId: string,
    ): Promise<EstimateResponse> {
      const auth = await authenticate(bearerToken);

      if (!UUID_RE.test(estimateId)) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Estimate not found.',
          false,
        );
      }

      let record: EstimateRecord | null;
      try {
        record = await deps.estimates.findById(estimateId);
      } catch (error) {
        throw new Error('estimate lookup failed', { cause: error });
      }
      if (!record) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Estimate not found.',
          false,
        );
      }
      if (record.projectType !== 'new_build' && record.projectType !== 'renovation') {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Narratives are not available for this estimate type.',
          false,
        );
      }

      // Ownership: the estimate must belong to one of the caller's leads
      // (same pattern as legal/02's export).
      let userLeads;
      try {
        userLeads = await deps.leads.findAllByEmail(auth.email);
      } catch (error) {
        throw new Error('lead lookup failed', { cause: error });
      }
      const ownedEstimateIds = new Set(
        userLeads.map((l) => l.estimateId).filter(Boolean),
      );
      if (!ownedEstimateIds.has(record.id)) {
        await deps.audit.audit({
          leadId: auth.leadId,
          action: 'narrative.denied',
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This estimate does not belong to you.',
          false,
        );
      }

      // Cached narrative: return it without touching the LLM or the guard.
      if (record.narrative && record.narrativeGeneratedAt) {
        return toResponse(record, record.narrative, record.narrativeGeneratedAt);
      }

      // Cost guard: bounded LLM calls per estimate per trailing window.
      // The guard is re-checked BEFORE every provider call (not once
      // up-front): the budget is shared, a repair retry is a second call,
      // and a call costs money whether or not its output validates.
      // Concurrent uncached requests may each pass the check — the last
      // writer wins the cache, and the log stays append-only (documented
      // behavior; the window budget makes abuse uneconomical).
      const windowStart = (at: Date) =>
        new Date(at.getTime() - deps.generationWindowMs);
      const { prompt, output } = buildPrompt(record);

      // Generate + validate, with exactly one repair retry.
      let violations: readonly string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        let recent: number;
        try {
          recent = await deps.generations.countSince(
            record.id,
            windowStart(clock()),
          );
        } catch (error) {
          throw new Error('narrative generation count failed', { cause: error });
        }
        if (recent >= deps.maxGenerationsPerDay) {
          throw new HttpError(
            429,
            ErrorCodes.RATE_LIMITED,
            'Narrative generation limit reached for this estimate. Please try again tomorrow.',
          );
        }
        const attemptPrompt =
          attempt === 0 ? prompt : buildRepairPrompt(prompt, violations);
        try {
          await deps.generations.record(record.id, clock());
        } catch (error) {
          throw new Error('narrative generation record failed', {
            cause: error,
          });
        }
        let text: string;
        try {
          text = await deps.provider.generate(attemptPrompt);
        } catch {
          return failNarrative();
        }
        const validation = validateNarrative(text, output);
        if (validation.ok) {
          const generatedAt = clock();
          try {
            await deps.estimates.saveNarrative(record.id, text, generatedAt);
          } catch (error) {
            throw new Error('narrative persist failed', { cause: error });
          }
          return toResponse(record, text, generatedAt);
        }
        violations = validation.violations;
      }
      return failNarrative();
    },
  };
}
