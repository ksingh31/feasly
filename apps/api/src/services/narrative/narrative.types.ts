/**
 * Narrative provider abstraction (story consumer/06).
 *
 * One interface every narrative LLM implements. The provider is the
 * OpenAI-compatible chat-completions endpoint (Gemini, Karan's pick):
 * the log provider handles dev/test, and the real adapter fails closed
 * with a clear configuration error until its API key is configured.
 * Nothing outside this module constructs a provider.
 *
 * The provider receives the ALREADY-ASSEMBLED prompt (from
 * `buildNarrativePrompt()` in @feasly/cost-engine) — it never sees the
 * estimate, the cost data, or any PII. It returns raw text; validation
 * (`validateNarrative()`) happens in the service, not here.
 */
import type { NarrativePrompt } from '@feasly/cost-engine';

/** Raw LLM output — unvalidated text. The service validates before use. */
export interface NarrativeProviderResult {
  readonly text: string;
  /** Model identifier that produced this output (for audit/logging). */
  readonly model: string;
}

/**
 * Synthetic-output marker (bug goal_aec0b247775d).
 *
 * Identifies log-provider placeholder text. The narrative service and the
 * report service strip any narrative containing this marker before it can
 * reach a user-facing response — this also covers rows persisted before
 * the guard existed. The log provider builds its text from this constant
 * so the two can never drift apart.
 */
export const NARRATIVE_SYNTHETIC_MARKER = 'synthetic narrative placeholder';

/** True when the text is log-provider placeholder output. */
export function isSyntheticNarrative(text: string): boolean {
  return text.includes(NARRATIVE_SYNTHETIC_MARKER);
}

export class NarrativeProviderError extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NarrativeProviderError';
  }
}

export interface NarrativeProvider {
  /**
   * True when this provider emits synthetic dev/test output (the log
   * provider) rather than a real LLM narrative. The service never
   * validates, persists, or returns synthetic output — the report falls
   * back to its "summary unavailable" state instead. `false` for the real
   * (Gemini) adapter.
   */
  readonly synthetic: boolean;
  /**
   * Generate narrative text for the assembled prompt.
   * Throws NarrativeProviderError on transport/auth failures.
   * Never throws on "bad" text — the service validates the output.
   */
  generate(prompt: NarrativePrompt): Promise<NarrativeProviderResult>;
}
