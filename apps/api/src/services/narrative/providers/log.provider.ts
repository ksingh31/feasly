/**
 * Log narrative provider (story consumer/06).
 *
 * Dev/test transport: logs the prompt to the console instead of calling
 * the network, and returns a deterministic placeholder narrative that
 * passes `validateNarrative()` (engine figures only, verbatim footer).
 * This keeps dev/test fully local — no API key, no spend, no flakes.
 *
 * The placeholder is clearly marked as synthetic so it can never be
 * mistaken for a real LLM output in logs.
 */
import {
  NARRATIVE_FOOTER,
  type NarrativePrompt,
} from '@feasly/cost-engine';
import {
  NarrativeProviderError,
  type NarrativeProvider,
  type NarrativeProviderResult,
} from '../narrative.types';

export function createLogNarrativeProvider(): NarrativeProvider {
  return {
    async generate(prompt: NarrativePrompt): Promise<NarrativeProviderResult> {
      // Log the prompt shape (never the full text — it contains the
      // estimate figures, which are the user's data).
      console.log(
        `[narrative:log] prompt assembled (system: ${prompt.system.length} chars, user: ${prompt.user.length} chars) — returning deterministic placeholder`,
      );
      // Deterministic placeholder: references the figures already in the
      // prompt (no invented numbers) + the verbatim footer so it passes
      // validateNarrative(). Marked synthetic.
      const text =
        `This is a synthetic narrative placeholder (log provider — no LLM was called). ` +
        `The estimate figures above were calculated deterministically from our cost model. ` +
        `Configure the Meta API provider for a real AI-generated summary. ${NARRATIVE_FOOTER}`;
      if (!text) {
        throw new NarrativeProviderError('log provider produced empty text');
      }
      return { text, model: 'log-placeholder' };
    },
  };
}
