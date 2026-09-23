# FE-3 — Analyzing beat + Preview (S4–S5)

**Goal:** the most delicate two screens in the product. S4 must feel like real work
happening (because it maps to real calls — even against mocks). S5 must build desire
while leaking nothing: blurred figures, one gate, one way forward.

## Stories (build order)

### FE3-001 — S4 analyzing beat (honest progress, never fake)
**Size:** M
**Description:** Dark full-screen beat (`--canvas`): four steps — "Looking up property
record…", "Pulling lot & zoning details…", "Calculating build cost…", "Generating
your preview…". Each line maps 1:1 to an awaited mock promise (property resolve →
enrichment → `POST /api/v1/estimates` → preview readiness); steps light up only as
promises resolve. Auto-advance to `/preview` with a fade. `prefers-reduced-motion`:
instant, no animation. Any failure → S1-style error panel with Retry (never stranded
on dark). Refresh on `/analyzing` resumes at S3. Route is CSR + `noindex`.
**Acceptance criteria:**
- Step 3 cannot show complete before the estimate promise resolves (deferred-promise test).
- No `setTimeout` > 300ms in the component (lint rule) — total screen time = real latency.
- Failure renders the error panel + working Retry; dark screen never sticks.
- Reduced-motion: no fade, steps still advance on promise resolution.
**Tests:** spec — promise mapping, retry, refresh-resume; UI — dark beat visuals.
**Mobile:** full-screen beat at 390×844; steps legible; respects reduced-motion OS setting.
**Config notes:** step labels + simulated latency range from config.
**Dependencies:** FE2-004 (wizard state feeds the estimate request).

### FE3-002 — S5 preview: blur + the single Unlock
**Size:** M
**Description:** VISIBLE: address, community, lot size, zoning, assessed value, sqft,
tier. BLURRED (CSS blur + lock icon, `aria-hidden` with the text alternative
"Available after email verification"): build cost range, total project range. Copy:
"Your numbers are ready." Primary CTA "Unlock Full Numbers →" — the only "Unlock" in
the product (copy-lint enforced repo-wide). Secondary "← Edit my details" → S3 with
state intact. Mock contract: figures arrive as `{ blurred: true }` placeholders —
real numbers never in the DOM, view-source, or prerendered HTML. No other forward path.
**Acceptance criteria:**
- `document.body.innerHTML` contains no `$`+digits inside blurred regions (test).
- "Unlock" (case-insensitive) appears exactly once in `apps/web/src` (lint).
- "Edit my details" returns to S3 intact; re-running preview reuses the cached
  estimate (single `estimate_id` — no duplicates).
- Blur degrades gracefully without CSS filters (solid overlay fallback).
**Tests:** spec — placeholder handling, single-estimate caching; UI — blur + lock visuals.
**Mobile:** blurred cards stack; CTA sticky at bottom, clear of inputs; lock icon scales.
**Config notes:** "Your numbers are ready." + alt-text from config.
**Dependencies:** FE3-001.
