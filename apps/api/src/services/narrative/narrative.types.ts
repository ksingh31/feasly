/**
 * Narrative provider abstraction (story consumer/06).
 *
 * One interface every narrative LLM implements. The provider is the Meta
 * API (Karan's pick): the log provider handles dev/test, and the Meta
 * adapter fails closed with a clear configuration error until its API key
 * is configured. Nothing outside this module constructs a provider.
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
   * Generate narrative text for the assembled prompt.
   * Throws NarrativeProviderError on transport/auth failures.
   * Never throws on "bad" text — the service validates the output.
   */
  generate(prompt: NarrativePrompt): Promise<NarrativeProviderResult>;
}
