/**
 * OpenAI-compatible narrative provider (story consumer/06, chain BE-9).
 *
 * Real adapter over any OpenAI-protocol chat-completions endpoint —
 * currently Google's Gemini API (Karan's pick, 2026-09-27; Meta retired
 * its hosted Llama API). The provider receives the already-assembled
 * prompt — it never sees the estimate, cost data, or PII beyond what
 * `buildNarrativePrompt()` interpolated (figures + city facts, no
 * names/emails).
 *
 * Wiring: `NARRATIVE_API_KEY` (config, Key Vault reference in
 * staging/production — never committed; the secrets-hygiene tripwire
 * fails the build if a key literal ever lands in this module). A missing
 * key fails closed at generate time naming the exact env var.
 *
 * Model chain (BE-9): `models` is the config-owned ordered list
 * (`NARRATIVE_MODELS`, primary first). On transient failures — capacity
 * errors (HTTP 408/429/5xx incl. 529), timeouts, or network errors — the
 * provider tries the next model. It FAILS FAST (no chain) on other 4xx
 * (bad request, bad key, forbidden, unknown model), a missing API key, or
 * a missing endpoint. The result's `model` records which model served.
 *
 * Endpoint: `NARRATIVE_ENDPOINT` is the provider base URL (e.g. the
 * Gemini OpenAI-compatibility base). `chatCompletionsUrl()` appends
 * `/chat/completions` when the configured value does not already end
 * with it, so both the bare base and the full path work.
 *
 * Timeouts: `timeoutMs` per attempt (config `NARRATIVE_TIMEOUT_MS`,
 * default 30s here, 20s in config). The service owns retry policy (one
 * repair retry on validation failure).
 */
import type { NarrativePrompt } from '@feasly/cost-engine';
import {
  NarrativeProviderError,
  type NarrativeProvider,
  type NarrativeProviderResult,
} from '../narrative.types';

export interface OpenAiCompatibleProviderDeps {
  /**
   * LLM API key — from NARRATIVE_API_KEY (Key Vault reference in
   * staging/production). Absent = fail-closed generation.
   */
  readonly apiKey?: string;
  /**
   * Ordered model list, primary first (from NARRATIVE_MODELS). At least
   * one entry is required — construction throws otherwise.
   */
  readonly models: readonly string[];
  /** Endpoint base URL (from NARRATIVE_ENDPOINT config). */
  readonly endpoint?: string;
  /** Fetch implementation (injected for tests). */
  readonly fetchImpl?: typeof fetch;
  /** Per-attempt timeout in ms (from NARRATIVE_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/** Default per-attempt timeout when the caller passes none. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * HTTP statuses worth chaining to the next model: rate limiting, request
 * timeout, and the server-side transient family (500/502/503/504, plus
 * 529 — the "overloaded" code some providers use). Everything else 4xx
 * fails fast: retrying another model won't fix a bad request or bad key.
 */
function isChainableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 529 ||
    (status >= 500 && status <= 599)
  );
}

/** True when the error is an AbortSignal.timeout() expiry. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

function logChainEvent(
  event: 'narrative.model-attempt' | 'narrative.model-chained' | 'narrative.model-served',
  fields: Record<string, string>,
): void {
  console.info(JSON.stringify({ event, provider: 'openai-compatible', ...fields }));
}

/**
 * Resolve the chat-completions URL from a configured base. Appends
 * `/chat/completions` when the value does not already end with it.
 */
export function chatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/**
 * Pull `error.message` from an OpenAI-style (`{error: {message}}`) or
 * Google-style (`[{error: {message}}]`) error envelope. Returns null when
 * the body carries no usable message.
 */
function extractErrorMessage(json: unknown): string | null {
  const envelope = Array.isArray(json) ? json[0] : json;
  if (typeof envelope !== 'object' || envelope === null) return null;
  const error = (envelope as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return null;
}

/**
 * Build a safe one-line reason from an error response. Only the
 * provider's own `error.message` string is used — never the raw body —
 * single-lined and capped for safe logging. Any accidental echo of the
 * API key is redacted.
 */
async function errorDetail(res: Response, apiKey: string): Promise<string> {
  try {
    const message = extractErrorMessage(await res.json());
    if (!message) return '';
    let detail = message.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (detail.includes(apiKey)) {
      detail = detail.split(apiKey).join('[redacted]');
    }
    return detail ? `: ${detail}` : '';
  } catch {
    // Non-JSON error body — fall back to the status-only message.
    return '';
  }
}

export function createOpenAiCompatibleNarrativeProvider(
  deps: OpenAiCompatibleProviderDeps,
): NarrativeProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Endpoint comes from NARRATIVE_ENDPOINT config (no hardcoded default
  // in services/ — the boundaries test forbids URL literals here).
  const configured = deps.endpoint;
  if (!configured) {
    throw new NarrativeProviderError(
      'NARRATIVE_ENDPOINT is not configured.',
    );
  }
  if (deps.models.length === 0) {
    throw new NarrativeProviderError(
      'NARRATIVE_MODELS is empty — configure at least one narrative model.',
    );
  }
  const models = [...deps.models];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = chatCompletionsUrl(configured);
  // Pasted secrets sometimes carry stray whitespace/newlines (console
  // paste into Key Vault) — a padded key is never valid, so trim before
  // use. A whitespace-only value fails closed like a missing one.
  const apiKey = deps.apiKey?.trim();
  return {
    // Real provider — output is validated and may be persisted/returned.
    synthetic: false,
    async generate(
      prompt: NarrativePrompt,
    ): Promise<NarrativeProviderResult> {
      if (!apiKey) {
        throw new NarrativeProviderError(
          'NARRATIVE_API_KEY is not configured — narrative generation is disabled until Karan provides the Gemini API key.',
        );
      }
      let lastError: NarrativeProviderError | null = null;
      for (let i = 0; i < models.length; i++) {
        const model = models[i]!;
        const isLast = i === models.length - 1;
        logChainEvent('narrative.model-attempt', { model });
        try {
          const result = await attemptModel(
            fetchImpl,
            endpoint,
            apiKey,
            model,
            prompt,
            timeoutMs,
          );
          logChainEvent('narrative.model-served', { model });
          return result;
        } catch (error) {
          const providerError =
            error instanceof NarrativeProviderError
              ? error
              : new NarrativeProviderError('LLM API request failed', {
                  cause: error,
                });
          lastError = providerError;
          const chainable =
            providerError.status !== undefined
              ? isChainableStatus(providerError.status)
              : true;
          if (!chainable || isLast) throw providerError;
          logChainEvent('narrative.model-chained', {
            model,
            reason: providerError.message,
            next: models[i + 1]!,
          });
        }
      }
      // Unreachable — the loop always throws on the last model — but the
      // type system needs a terminal throw.
      throw (
        lastError ??
        new NarrativeProviderError('All narrative models failed.')
      );
    },
  };
}

/**
 * Single-model attempt. Throws NarrativeProviderError carrying the HTTP
 * status when the response is an error status, so the chain can decide
 * whether to advance. Transport failures (timeout, network) surface as a
 * status-less NarrativeProviderError — the chain treats those as
 * transient and advances.
 */
async function attemptModel(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: NarrativePrompt,
  timeoutMs: number,
): Promise<NarrativeProviderResult> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        // Low temperature: the narrative must stay close to the
        // engine figures, not get creative.
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new NarrativeProviderError(
        `LLM API request timed out after ${timeoutMs}ms for model ${model}`,
        { cause: error },
      );
    }
    throw new NarrativeProviderError('LLM API request failed', {
      cause: error,
    });
  }
  if (!res.ok) {
    // Include the provider's own error message (sanitized) — a bare
    // status is undiagnosable, as the 2026-09-27 Gemini HTTP 400
    // outage proved: nobody could tell a bad key from a bad request.
    throw new NarrativeProviderError(
      `LLM API returned HTTP ${res.status} for model ${model}${await errorDetail(res, apiKey)}`,
      { status: res.status },
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (error) {
    throw new NarrativeProviderError(
      'LLM API returned non-JSON response',
      { cause: error },
    );
  }
  const text = extractText(json);
  if (!text) {
    throw new NarrativeProviderError(
      'LLM API returned no usable completion text',
    );
  }
  return { text, model };
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
