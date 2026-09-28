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
 * Model chain (BE-9): `targets` is the config-owned ordered list of
 * provider steps (`NARRATIVE_*` primary first, `NARRATIVE_FALLBACK_*`
 * second — Gemini then Groq today). Each target carries its own
 * endpoint, API key, and ordered model list. On transient failures —
 * capacity errors (HTTP 408/429/5xx incl. 529), timeouts, or network
 * errors — the provider tries the next model, then the next target. It
 * FAILS FAST (no chain) on other 4xx (bad request, bad key, forbidden,
 * unknown model) or a missing primary API key. A fallback target with
 * no API key is skipped gracefully (logged, key never logged) so the
 * Groq step stays dormant until Karan provisions its key. The result's
 * `model` records which model served.
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

export interface NarrativeProviderTarget {
  /**
   * Log label for this provider step (e.g. 'gemini', 'groq'). Used in
   * chain telemetry only — never a secret, never logged with a key.
   */
  readonly label: string;
  /**
   * LLM API key for this target — from NARRATIVE_API_KEY (primary) or
   * NARRATIVE_FALLBACK_API_KEY (fallback, Key Vault reference in
   * staging/production). Absent on the primary = fail-closed
   * generation; absent on a fallback = the step is skipped gracefully.
   */
  readonly apiKey?: string;
  /**
   * Ordered model list for this target, primary first (from
   * NARRATIVE_MODELS / NARRATIVE_FALLBACK_MODELS). At least one entry
   * is required — construction throws otherwise.
   */
  readonly models: readonly string[];
  /** Endpoint base URL for this target (from NARRATIVE_ENDPOINT / NARRATIVE_FALLBACK_ENDPOINT). */
  readonly endpoint?: string;
}

export interface OpenAiCompatibleProviderDeps {
  /**
   * Ordered provider targets — primary first. The chain advances across
   * targets on capacity errors (408/429/5xx), timeouts, and network
   * failures. At least one target is required.
   */
  readonly targets: readonly NarrativeProviderTarget[];
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
  event:
    | 'narrative.model-attempt'
    | 'narrative.model-chained'
    | 'narrative.model-served'
    | 'narrative.model-truncated'
    | 'narrative.provider-skipped',
  fields: Record<string, string>,
): void {
  console.info(JSON.stringify({ event, provider: 'openai-compatible', ...fields }));
}

/** Token budget for the first attempt (matches the historical value). */
const PRIMARY_MAX_TOKENS = 800;
/**
 * Token budget for the single truncation retry. A model that stops at the
 * budget (`finish_reason: 'length'`) is usually just long-winded — 2x
 * headroom lets it finish. Past this the completion is abandoned (fatal)
 * rather than chained: the same prompt would truncate on the next model
 * too, burning spend, and a truncated body must never be stored or
 * served with the deterministic footer appended.
 */
const TRUNCATION_RETRY_MAX_TOKENS = 1600;

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
  if (deps.targets.length === 0) {
    throw new NarrativeProviderError('No narrative provider targets configured.');
  }
  // Endpoints come from config (no hardcoded defaults in services/ —
  // the boundaries test forbids URL literals here). Pasted secrets
  // sometimes carry stray whitespace/newlines (console paste into Key
  // Vault) — a padded key is never valid, so trim before use; a
  // whitespace-only value counts as missing.
  const targets = deps.targets.map((t) => {
    if (!t.endpoint) {
      throw new NarrativeProviderError(
        `NARRATIVE_ENDPOINT is not configured for provider '${t.label}'.`,
      );
    }
    if (t.models.length === 0) {
      throw new NarrativeProviderError(
        `NARRATIVE_MODELS is empty for provider '${t.label}' — configure at least one narrative model.`,
      );
    }
    return {
      label: t.label,
      endpoint: chatCompletionsUrl(t.endpoint),
      apiKey: t.apiKey?.trim() || undefined,
      models: [...t.models],
    };
  });
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    // Real provider — output is validated and may be persisted/returned.
    synthetic: false,
    async generate(
      prompt: NarrativePrompt,
    ): Promise<NarrativeProviderResult> {
      let lastError: NarrativeProviderError | null = null;
      for (let ti = 0; ti < targets.length; ti++) {
        const target = targets[ti]!;
        const isPrimary = ti === 0;
        const isLastTarget = ti === targets.length - 1;
        if (!target.apiKey) {
          if (isPrimary) {
            throw new NarrativeProviderError(
              'NARRATIVE_API_KEY is not configured — narrative generation is disabled until Karan provides the Gemini API key.',
            );
          }
          // Fallback step dormant until its key is provisioned — skip
          // gracefully (label only, never the key) and let the chain
          // continue to the next target / static guide.
          logChainEvent('narrative.provider-skipped', {
            target: target.label,
            reason: 'api-key-missing',
          });
          continue;
        }
        for (let i = 0; i < target.models.length; i++) {
          const model = target.models[i]!;
          const isLast = isLastTarget && i === target.models.length - 1;
          logChainEvent('narrative.model-attempt', {
            target: target.label,
            model,
          });
          try {
            const result = await attemptModel(
              fetchImpl,
              target.endpoint,
              target.apiKey,
              model,
              prompt,
              timeoutMs,
              target.label,
            );
            logChainEvent('narrative.model-served', {
              target: target.label,
              model,
            });
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
              !providerError.fatal &&
              (providerError.status === undefined ||
                isChainableStatus(providerError.status));
            if (!chainable || isLast) throw providerError;
            const nextModel = target.models[i + 1];
            logChainEvent('narrative.model-chained', {
              target: target.label,
              model,
              reason: providerError.message,
              next: nextModel ?? targets[ti + 1]!.label,
            });
          }
        }
      }
      // Unreachable — the loop always throws on the last model — but the
      // type system needs a terminal throw.
      throw (
        lastError ??
        new NarrativeProviderError('All narrative provider targets failed.')
      );
    },
  };
}

/**
 * Single HTTP round trip against one model with the given token budget.
 * Returns the assistant text plus the OpenAI finish reason. Throws
 * NarrativeProviderError carrying the HTTP status when the response is
 * an error status, so the chain can decide whether to advance.
 * Transport failures (timeout, network) surface as a status-less
 * NarrativeProviderError — the chain treats those as transient and
 * advances.
 */
async function requestCompletion(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: NarrativePrompt,
  timeoutMs: number,
  maxTokens: number,
): Promise<{ text: string; finishReason: string | null }> {
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
        max_tokens: maxTokens,
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
  const completion = extractCompletion(json);
  if (!completion.text) {
    throw new NarrativeProviderError(
      'LLM API returned no usable completion text',
    );
  }
  return { text: completion.text, finishReason: completion.finishReason };
}

/**
 * Single-model attempt with one truncation retry. When the model stops
 * because it hit the token budget (`finish_reason: 'length'`), retry
 * once with a higher budget — the first attempt's cut-off text is
 * discarded, never returned. If the retry also truncates, throw a FATAL
 * error: chaining to the next model would burn spend on the same prompt,
 * and the truncated text must never be stored or served (the service
 * falls back to the static guide instead).
 */
async function attemptModel(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: NarrativePrompt,
  timeoutMs: number,
  targetLabel: string,
): Promise<NarrativeProviderResult> {
  const first = await requestCompletion(
    fetchImpl,
    endpoint,
    apiKey,
    model,
    prompt,
    timeoutMs,
    PRIMARY_MAX_TOKENS,
  );
  if (first.finishReason !== 'length') {
    return { text: first.text, model };
  }
  logChainEvent('narrative.model-truncated', {
    target: targetLabel,
    model,
    maxTokens: String(PRIMARY_MAX_TOKENS),
  });
  const retry = await requestCompletion(
    fetchImpl,
    endpoint,
    apiKey,
    model,
    prompt,
    timeoutMs,
    TRUNCATION_RETRY_MAX_TOKENS,
  );
  if (retry.finishReason !== 'length') {
    return { text: retry.text, model };
  }
  throw new NarrativeProviderError(
    `LLM API returned a truncated completion (finish_reason=length) for model ${model} even at ${TRUNCATION_RETRY_MAX_TOKENS} tokens — refusing to store or serve it`,
    { fatal: true },
  );
}

/**
 * Extract the assistant text and finish reason from an OpenAI-compatible
 * chat response. `finish_reason` is 'stop' | 'length' | 'content_filter'
 * | ... per the OpenAI protocol (Gemini's compatibility endpoint uses
 * the same field); null when the provider omits it.
 */
function extractCompletion(json: unknown): {
  text: string | null;
  finishReason: string | null;
} {
  if (typeof json !== 'object' || json === null)
    return { text: null, finishReason: null };
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0)
    return { text: null, finishReason: null };
  const first = choices[0] as {
    message?: { content?: unknown };
    finish_reason?: unknown;
  };
  const content = first?.message?.content;
  return {
    text:
      typeof content === 'string' && content.trim().length > 0
        ? content.trim()
        : null,
    finishReason:
      typeof first?.finish_reason === 'string' ? first.finish_reason : null,
  };
}
