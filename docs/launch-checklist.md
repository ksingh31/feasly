# Feasly launch checklist (HRD-05)

The list of things that must be true before Feasly serves production traffic.
Items marked **[GATE]** are enforced by CI/CD — the deploy physically cannot
proceed until they pass. Items marked **[KARAN]** need a decision or artifact
only Karan can provide.

> **Karan's sign-off:** _[pending — Karan signs here (written approval) before
> production traffic]_
> Date: _[pending]_

## Legal & compliance

- [ ] **[KARAN][GATE]** Lawyer reviews and approves privacy policy, terms,
      and PIPEDA copy. The draft wording lives in
      `docs/legal/approved-copy.md` and the served pages; every copy is
      marked `draft-pending-lawyer`.
  - Gate: `apps/web/tools/check-legal-gate.mjs` fails the production deploy
    while any marker remains.
  - When approved: replace the draft text, remove every marker, record the
    review date here.

- [ ] **[GATE]** CASL opt-in wording on the lead gate byte-matches the
      approved copy in `docs/legal/approved-copy.md`.
  - Gate: `apps/web/tools/check-casl-copy.mjs` (CI).

- [ ] **[GATE]** No banned claims in user-facing copy: `guarantee`, `±`,
      `accurate within/to`, `market value`, `appraisal` (outside explicit
      disclaimer forms like "not guarantees").
  - Gate: `apps/web/tools/check-banned-phrases.mjs` (CI).

- [ ] **[GATE]** The deterministic disclaimer appears on all four surfaces:
      report page, print/PDF, API `EstimateResponse.disclaimer`, MCP tool
      descriptions (MCP pending api-mcp/06).
  - Gate: same `check-banned-phrases.mjs` (CI).

- [ ] **[KARAN]** Platform agreement reviewed by the lawyer (blocks the 1%
      commission billing engine going live, not the MVP launch).

## Data & placeholders

- [ ] **[GATE]** No unswapped placeholders: `PLACEHOLDER`, `TODO(launch)`,
      `FIXME(launch)`, the standing test email — outside the explicit
      allowlist in `tools/placeholder-allowlist.txt`.
  - Gate: `tools/check-placeholders.mjs` (CI).

- [ ] **[KARAN]** Cost-engine calibration: Karan's cost Sheet (3–4 completed
      houses) arrives; a calibrated cost-data version replaces the
      uncalibrated stand-ins (story cost-engine/01). The engine refuses
      customer-facing estimates until then.

- [ ] **[KARAN]** Production domain decided (feasly.com unverified) —
      replaces the `SITE_URL` placeholder in
      `apps/web/src/app/core/config/app-config.defaults.ts`.

- [ ] **[KARAN]** Ops inbox named — replaces the standing test email default
      `OPS_INBOX_EMAIL` in `apps/api/src/config.ts`.

- [ ] **[KARAN]** Elite Craft brand assets (logo, fallback phone/email) —
      replaces the placeholders in `config/builders/elite-craft-builders.json`
      (story embed/05).

- [ ] **[KARAN]** Callback/share outbound notifications: no email/SMS is
      sent yet — callback requests and partner shares persist and are worked
      from the future inbox flow (placeholder allowlisted in
      `tools/placeholder-allowlist.txt`, `apps/api/src/services/callback.service.ts`).
      Unblocks when Karan's ACS sender-domain decision lands.

## Technical readiness

- [ ] All CI checks green on main (build, typecheck, lint, tests).
- [ ] Browser QA per the QA rule: Chrome desktop, Safari/WebKit, 375px
      responsive — covering the legal pages, lead gate, report, and print.
- [ ] SEO artifacts in place (sitemap, robots, llms.txt, per-page meta).
- [ ] SWA preview environments cleaned (cap: 3 staging envs).

## Post-launch (not blocking)

- Real Stripe production credentials (billing engine is dormant until then).
- Magic-link email via Azure Communication Services sender domain.
- Community pages rollout (seo/*) and programmatic content engine.
- MCP server public launch (api-mcp/06) — completes the fourth disclaimer
  surface.
