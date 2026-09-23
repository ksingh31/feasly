# FE-4 — Lead gate + magic link (S6–S7, /r/{token})

**Goal:** the single conversion point, designed to feel safe: ask for the minimum,
explain why, and make the email handoff frictionless. Then the magic-link round trip.

## Stories (build order)

### FE4-001 — S6 lead gate modal (ask less, convert more)
**Size:** M
**Description:** Focus-trapped modal (Escape → back to S5): "Where should we send your
full report?" Email (required, inline validation), Name — "What should we call you?"
(required), Phone optional ("Only if you'd like a callback."), **one** timeline
question ("When are you hoping to build?" — chips: 0–3mo / 3–6mo / 6–12mo / 12+mo /
exploring; required, one tap), CASL checkbox **unchecked by default** ("Email me
Calgary market updates & building tips."). Microcopy: "We'll email your full report.
No spam, unsubscribe anytime." + Privacy/Terms links. On embeds: one extra consent
line naming the builder ("Your details go to {builder_name}…"). CTA "Send My Full
Report →". Mock contract: `POST /api/v1/leads` (lead persisted even if the link is
never clicked) → S7. Send failure: inline error + Retry. Double-submit guarded.
**Acceptance criteria:**
- CTA disabled until email valid + name + timeline chosen (no error nagging).
- Double-click can't create duplicate leads (in-flight disable test).
- CASL unchecked by default; checking records consent (contract test).
- Embed variant renders the builder consent line from `EmbedTenantConfig`.
- Focus trap: tab cycles in modal, Escape returns focus to the S5 CTA; screen reader
  announces the dialog.
**Tests:** spec — validation, timeline requirement, double-submit guard, focus trap;
UI — modal visuals.
**Mobile:** modal becomes a bottom sheet at 390px; keyboard doesn't cover the CTA
(`visualViewport` handling); chips ≥44px; inputs font-size ≥16px.
**Config notes:** all copy, chip labels, CASL text from config.
**Dependencies:** FE3-002.

### FE4-002 — S7 check-email + resend
**Size:** S
**Description:** "We sent a secure link to {email}." Resend with 60s cooldown (visible
countdown, then re-enable), "Wrong email? Go back" (→ S6, fields intact). Validity
note rendered from the API's `expires_in_days` — never hardcoded ("This link is
valid for {n} days.").
**Acceptance criteria:**
- Resend disabled with countdown for 60s; "Wrong email?" restores S6 values.
- Validity copy matches the mock's `expires_in_days` (single source test).
**Tests:** spec — cooldown timer, back-navigation state; UI — layout.
**Mobile:** countdown legible; links ≥44px targets.
**Config notes:** cooldown seconds + validity copy from config/API.
**Dependencies:** FE4-001.

### FE4-003 — /r/{token}: verify, render, expire, re-issue
**Size:** M
**Description:** CSR-only route (`noindex`, never prerendered, absent from sitemap).
On load: `GET /api/v1/magic-links/verify/{token}` → valid renders the report shell
(FE-5 content); invalid/expired shows "This link has expired. Enter your email and
we'll send a fresh one." + email input → re-issue (`POST /api/v1/magic-links/reissue`).
Mock supports a `?mock-token=` dev shortcut (dev builds only — never in prod bundles;
build-time assertion). Raw token never in client logs.
**Acceptance criteria:**
- Valid token → report; expired → exact re-issue copy + working re-issue round trip.
- `noindex` meta present; route absent from `sitemap.xml` (FE-6 parity test).
- Prod bundle contains no `mock-token` handling (grep CI).
- Token never appears in logs/error reports (lint: no `console.log(token)`).
**Tests:** spec — verify/expire/re-issue flows, token hygiene; UI — expired-state layout.
**Mobile:** re-issue form usable one-handed; report shell skeleton while verifying.
**Config notes:** expired-state copy from config.
**Dependencies:** FE4-001, FE5-001 (report shell).
