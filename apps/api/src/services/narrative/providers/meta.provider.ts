/**
 * Meta API narrative provider (story consumer/06).
 *
 * Real adapter over the Meta Llama API (Karan's pick, 2026-09-22) using
 * its OpenAI-compatible chat-completions endpoint. The provider receives
 * the already-assembled prompt — it never sees the estimate, cost data,
 * or PII beyond what `buildNarrativePrompt()` interpolated (figures +
 * city facts, no names/emails).
 *
 * Wiring: `NARRATIVE_META_API_KEY` (config, Key Vault reference in
 * staging/production — never committed; the secrets-hygiene tripwire
 * fails the build if a key literal ever lands in this module). A missing
 * key fails closed at generate time naming the exact env var. The model
 * (`NARRATIVE_MODEL`, default `llama-3.3-70b-versatile`) comes from config.
 *
 * Timeouts: 30s per attempt (AbortSignal.timeout). The service owns
 * retry policy (one repair retry on validation failure).
 */
import type { NarrativePrompt } from '@feasly/cost-engine';
import {
  NarrativeProviderError,
  type NarrativeProvider,
  type NarrativeProviderResult,
} from '../narrative.types';


export interface MetaNarrativeProviderDeps {
  /**
   * Meta API key — from NARRATIVE_META_API_KEY (Key Vault reference in
   * staging/production). Absent = fail-closed generation.
   */
  readonly apiKey?: string;
  /** Model name, e.g. 'llama-3.3-70b-versatile'. */
  readonly model: string;
  /** API endpoint (from NARRATIVE_META_ENDPOINT config). */
  readonly endpoint?: string;
  /** Fetch implementation (injected for tests). */
  readonly fetchImpl?: typeof fetch;
}

export function createMetaNarrativeProvider(
  deps: MetaNarrativeProviderDeps,
): NarrativeProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Endpoint comes from NARRATIVE_META_ENDPOINT config (no hardcoded default
  // in services/ — the boundaries test forbids URL literals here).
  const endpoint = deps.endpoint;
  if (!endpoint) {
    throw new NarrativeProviderError(
      'NARRATIVE_META_ENDPOINT is not configured.',
    );
  }
  return {
    async generate(
      prompt: NarrativePrompt,
    ): Promise<NarrativeProviderResult> {
      if (!deps.apiKey) {
        throw new NarrativeProviderError(
          'NARRATIVE_META_API_KEY is not configured — narrative generation is disabled until Karan provides the Meta API key.',
        );
      }
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({
            model: deps.model,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            // Low temperature: the narrative must stay close to the
            // engine figures, not get creative.
            temperature: 0.3,
            max_tokens: 800,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        throw new NarrativeProviderError('Meta API request failed', {
          cause: error,
        });
      }
      if (!res.ok) {
        // Never include the response body verbatim — it could contain
        // fragments of the prompt (user data). Status + model only.
        throw new NarrativeProviderError(
          `Meta API returned HTTP ${res.status} for model ${deps.model}`,
        );
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (error) {
        throw new NarrativeProviderError(
          'Meta API returned non-JSON response',
          { cause: error },
        );
      }
      const text = extractText(json);
      if (!text) {
        throw new NarrativeProviderError(
          'Meta API returned no usable completion text',
        );
      }
      return { text, model: deps.model };
    },
  };
}

/** Extract the assistant text from an OpenAI-compatible chat response. */
function extractText(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim();
  }
  return null;
}
