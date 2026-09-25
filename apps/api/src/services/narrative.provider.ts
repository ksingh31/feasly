/**
 * LLM provider abstraction for the AI narrative worker (consumer/06).
 *
 * The narrative worker never talks to an LLM directly — it depends on this
 * interface, and composition wires the implementation from
 * `NARRATIVE_PROVIDER`:
 *
 * - `log` (default): logs the prompt and returns a deterministic placeholder
 *   narrative. No network, no cost — the placeholder until Karan provisions
 *   `META_API_KEY`. The placeholder carries no $-figures and ends with the
 *   verbatim footer, so it always passes `validateNarrative()`.
 * - `meta`: Karan's pick — the Meta API over an OpenAI-compatible
 *   chat-completions transport. Fail-fast: constructing it without an API
 *   key or base URL throws naming the missing variable.
 *
 * Pure interface + factories: no I/O at import time, no env reads (the
 * caller injects everything).
 */
import { NARRATIVE_FOOTER, type NarrativePrompt } from '@feasly/cost-engine';

/** Generates one narrative string from an assembled prompt. */
export interface NarrativeProvider {
  generate(prompt: NarrativePrompt): Promise<string>;
}

export interface LogNarrativeProviderDeps {
  /** Defaults to console — inject a collector in tests. */
  readonly log?: (message: string) => void;
}

/**
 * Deterministic placeholder provider (dev/test + the pre-provisioning
 * placeholder). Returns a footer-only narrative: honest about being a
 * placeholder, and validator-clean by construction.
 */
export function createLogNarrativeProvider(
  deps: LogNarrativeProviderDeps = {},
): NarrativeProvider {
  const log = deps.log ?? console.log;
  return {
    async generate(prompt: NarrativePrompt): Promise<string> {
      log(
        `[narrative:log-provider] system=${prompt.system.length} chars, ` +
          `user=${prompt.user.length} chars`,
      );
      return (
        'Narrative generation is not connected yet — this is a placeholder. ' +
        'Your estimate figures were calculated deterministically from our ' +
        'cost model. ' +
        NARRATIVE_FOOTER
      );
    },
  };
}

export interface MetaApiNarrativeProviderDeps {
  /** From config META_API_KEY — never logged. */
  readonly apiKey: string;
  /**
   * From config NARRATIVE_API_BASE_URL. Transport follows the
   * OpenAI-compatible chat-completions convention
   * (`POST {baseUrl}/chat/completions`); adjust the base URL if the Meta
   * API's path differs — no code change needed.
   */
  readonly baseUrl: string;
  /** From config NARRATIVE_MODEL. */
  readonly model: string;
  /** From config NARRATIVE_API_TIMEOUT_MS. */
  readonly timeoutMs: number;
  /** Test seam — defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

/**
 * Meta API narrative provider (Karan's pick). Throws
 * `NARRATIVE_PROVIDER_UNAVAILABLE`-style errors (plain Errors — the service
 * maps them to 502 `NARRATIVE_FAILED`) when the provider errors or returns
 * no usable content. The API key travels only in the Authorization header
 * and is never logged.
 */
export function createMetaApiNarrativeProvider(
  deps: MetaApiNarrativeProviderDeps,
): NarrativeProvider {
  const { apiKey, baseUrl, model, timeoutMs } = deps;
  if (!apiKey) {
    throw new Error(
      'Invalid configuration:\n  - META_API_KEY: required when NARRATIVE_PROVIDER=meta',
    );
  }
  if (!baseUrl) {
    throw new Error(
      'Invalid configuration:\n  - NARRATIVE_API_BASE_URL: required when NARRATIVE_PROVIDER=meta',
    );
  }
  const fetchFn = deps.fetchFn ?? fetch;
  // Path (not a full URL literal) — the host comes from config, so the
  // boundary test's no-URL-literals rule is satisfied.
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async generate(prompt: NarrativePrompt): Promise<string> {
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new Error('Meta API request failed', { cause: error });
      }
      if (!res.ok) {
        throw new Error(`Meta API error: HTTP ${res.status}`);
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch (error) {
        throw new Error('Meta API returned non-JSON', { cause: error });
      }
      const text = (data as { choices?: Array<{ message?: { content?: unknown } }> })
        ?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Meta API returned no usable content');
      }
      return text.trim();
    },
  };
}

export interface NarrativeProviderFactoryDeps {
  readonly provider: 'log' | 'meta';
  readonly model: string;
  readonly metaApiKey: string | undefined;
  readonly metaApiBaseUrl: string | undefined;
  readonly apiTimeoutMs: number;
  readonly log?: (message: string) => void;
}

/** Build the configured provider. Throws (fail-fast) on a bad meta setup. */
export function createNarrativeProvider(
  deps: NarrativeProviderFactoryDeps,
): NarrativeProvider {
  if (deps.provider === 'meta') {
    return createMetaApiNarrativeProvider({
      apiKey: deps.metaApiKey ?? '',
      baseUrl: deps.metaApiBaseUrl ?? '',
      model: deps.model,
      timeoutMs: deps.apiTimeoutMs,
    });
  }
  return createLogNarrativeProvider({ log: deps.log });
}
