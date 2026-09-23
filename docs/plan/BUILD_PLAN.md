# Feasly — Build Plan

**Status:** Draft — M0 blocked on Karan (GitHub/Azure access, cost Sheet, magic-link confirm, domain check)
**ADR:** `../adr/ADR-001-architecture.md` (approved 2026-09-22)

## Scope note

The original brief's strict Phase 1 is 8 pages (new-build lead engine only;
no renovation, comparison, or admin). The prototypes include all flows plus an
admin dashboard. This plan resolves the conflict pragmatically: **M1 ships the
strict brief scope** (new-build lead engine), **M2–M4 add the prototype flows**
as follow-on milestones on the same engine. No rework — the cost engine and
lead pipeline are shared from day one.

## Milestones

### M0 — Foundation (blocked)
- GitHub repo `feasly` (private), branch protection, Actions OIDC → Azure
- Azure: resource group, Static Web App, Function App, PostgreSQL, Bicep in repo
- CI/CD: PR preview environments, main → staging → production
- Repo layout (monorepo):
  ```
  feasly/
    apps/web/            # Angular SPA
    apps/api/            # Azure Functions (TypeScript)
    packages/cost-engine/ # deterministic engine, pure TS, unit-tested
    packages/mcp/        # MCP server (M5; thin wrapper over cost-engine + api)
    infra/bicep/         # all Azure resources
    .github/workflows/
  ```

### M1 — Walking skeleton: new-build lead engine (strict brief scope)
End-to-end, live, no mocks:
1. Landing (3 cards; reno/compare cards visible but "coming soon" if M2/M3 not done)
2. Address step → **real** City of Calgary assessment API (assessed value,
   neighbourhood, zoning, lot size, lot polygon)
3. Scope step (sqft slider, finish tier — no $/sqft in UI)
4. Deterministic estimate (server-side `cost-engine`): land visible, build/total
   blurred pre-gate
5. Lead gate (name, email, phone, timeline → hot/warm/cold scoring)
6. Magic-link email (Postmark) → full report: hero total, cost rows, AI narrative
   (Meta API, deterministic-math disclaimer), risk factors, PDF download
7. Lead stored in Postgres; admin-less lead view deferred to M4

**Exit criteria:** a stranger can go address → full report; every dollar figure
traceable to `cost-engine` + a pinned `cost_data_version`.

### M2 — Renovation flow
- 4 scope types from prototype (extensive, addition ≤400 sqft, basement +
  underpinning toggle, combined); ±20–25% ranges; permit/contingency notes
- Shares lead gate, magic link, report page, and lead pipeline with M1

### M3 — Neighbourhood comparison
- 2–3 neighbourhood side-by-side; land visible / build+total blurred; lowest-land
  badge; blurred bar chart; same lead gate unlock

### M4 — Admin + lead ops
- Lead dashboard (filters, hot/warm/cold, statuses new/contacted/qualified/closed,
  detail panel, notes, CSV export) — Angular route, admin-only auth
- Google Sheets auto-sync (Postgres = source of truth)
- Postmark templates finalized; CASL/PIPEDA consent wording (lawyer review before launch)

### M5 — Agent-friendly API + MCP (per ADR, Karan 2026-09-22)
- Versioned public API `/api/v1`: `get_property`, `estimate_project`, `submit_lead`
- API keys, scopes, rate limits, usage metering (per-estimate billing ready)
- MCP server wrapping the same tools; JSON schemas published
- Human UI and agent API share `cost-engine` — no duplicated logic

### M6 — Launch hardening
- Legal review (PIPEDA/CASL, disclaimers, terms)
- Accuracy tracking harness (±15% new-build / ±20–25% reno targets vs. quotes)
- Cost-data calibration loop from builder quotes
- Custom domain, SEO basics, analytics (consent-aware)

## What the prototypes give us (retain)

- Conversion flow: land visible pre-gate, build/total blurred on **real** values
- Ranges always; no $/sqft, no margins in UI
- Timeline → lead temperature mapping; lead statuses
- AI narrative with "dollar figures calculated deterministically" disclaimer
- Design tokens (canvas `#1C1914`, cream `#F7F4EF`, brass `#A8761A`;
  Syne display + Instrument Sans) → Angular theme in M1
- Report structure: hero total → cost rows → AI summary → risks → builder CTA

## What the prototypes get wrong (discard / fix)

- **All property data is fake** (quadrant regex, `address.length`-derived lot size,
  placeholder quadrant land $/sqft, 22-hood table) → replaced by real City API
- **Cost math runs client-side** in the prototype → must be server-side only
- Placeholder $/sqft tiers → replaced by calibration from Karan's Sheet (M0/M1)
- `AnalyzingStep` fake delays → replaced by real fetch + skeleton states
- Renovation badge says "Phase 2" in one file, full flow in another → M2 settles it

## Working agreements (standing)

- Muse builds; Karan answers + provides access + approves hard gates
- Hard gates: spend, cloud resources, domain purchase, anything external,
  production deploys
- All work in this side chat; code owned in Karan's GitHub
