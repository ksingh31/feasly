# BE-9 — Narrative fallback chain (resilience for the AI summary)

**Status:** building (branch `feat/narrative-fallback-chain`)
**Owner directive (Karan, 2026-09-27):** if the primary model errors, try backup
models; if nothing works, show a generic hard-coded Calgary building guide
instead of the current "not available" dead-end.

## Problem

The narrative worker (consumer/06) calls exactly one model
(`NARRATIVE_MODEL`, default `gemini-3.8-flash`). When that model is saturated
(HTTP 503 "high demand" — observed 2026-09-27, four straight failures), the
report page shows the honest-but-empty "AI summary is not available" state.
One model = one point of failure, and the fallback is a dead end.

## Design

Three-tier resilience chain, all behind the existing interfaces:

1. **Model chain (provider).** `NARRATIVE_MODELS` — config-owned ordered list,
   default `gemini-2.5-flash,gemini-2.5-flash-lite` (primary first). Same Gemini
   API key, same OpenAI-compatible endpoint — no new credentials. On capacity
   errors (HTTP 408/429/5xx incl. 529) or timeout/network failure, the provider
   tries the next model. Fail-fast (no chain) on other 4xx, missing API key,
   or missing endpoint. Per-attempt timeout `NARRATIVE_TIMEOUT_MS` (default
   20s) bounds the worst case. Every attempt logs a structured event naming
   the model; the result's `model` field records which model served.
2. **Cost guard (unchanged semantics).** The 5/day/estimate budget
   (`MAX_GENERATIONS_PER_DAY`) counts one `generateNarrative` call = one
   budgeted request — a full chain is ONE request, not one per model hop.
   `validateNarrative` (no invented dollar figures) and `ensureNarrativeFooter`
   apply to every LLM-produced summary, whichever model produced it.
3. **Static Calgary guide (final fallback).** When the chain is exhausted
   (provider error) — or the output fails validation after the repair retry —
   the service returns a hard-coded, honest, generic "Building in Calgary"
   guide (4 short paragraphs) instead of a 502. Rules: NO dollar figures, NO
   fake personalization ("in your neighbourhood"), NO invented facts. Safe
   topics: frost-depth/winter foundations, City permit process (general),
   infill vs greenfield, soil/grading awareness. Bypasses `validateNarrative`
   (nothing to validate) but KEEPS the verbatim compliance footer. Never
   persisted — the next visit retries the AI chain. Ops alert still fires.

**Honest labeling.** `NarrativeResponse.narrativeSource: 'ai' | 'static-guide'`
(new contract field). Frontend: the AI-summary section renders the guide under
the title "Building in Calgary" with the sub-note "Our AI summary is
unavailable right now — here's a general guide." Never presented as AI prose.
The old "not available" copy remains only for a true fetch failure (network
error calling the endpoint).

## Acceptance criteria

- [ ] 503/429/timeout on the primary model → next model tried; success
      returns with the serving model's name in `result.model`.
- [ ] 400/401/403 on the primary → fail fast, no second model attempted.
- [ ] All models exhausted → static guide returned: source `static-guide`,
      footer present exactly once, zero `$`-figures, not persisted.
- [ ] Validation failure after repair retry → static guide (not 502).
- [ ] Cached narratives return source `ai`; contract-conformance holds.
- [ ] Full API suite green; new provider-chain + service-guide tests green.
- [ ] Root `tsc -b` green; API lint green; web typecheck/lint/build green.
- [ ] Browser QA of the guide rendering (Chrome + Safari/WebKit,
      desktop + mobile) before merge.

## Out of scope

- New credentials or a second LLM vendor (same Gemini key/endpoint).
- Persisting the static guide; changing the 5/day budget; touching the 429
  rate-limit response.

## Summary

_(filled after implementation)_
