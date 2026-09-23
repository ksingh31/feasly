# ADR-001 — Feasly MVP Architecture

**Status:** Approved — Karan signed off 2026-09-22 ("ADR approved")
**Date:** 2026-09-22
**Project:** Feasly (standalone property/build feasibility platform, Calgary-first)

## Context

Feasly lets a user enter a Calgary address and get real property data plus
deterministic cost ranges for land, new build, and renovation — with AI
narrative on top — behind a lead-gate. Karan (Angular-comfortable) and Muse
(Muse builds, Karan answers + provides access) are building it as a personal
startup, no timeline pressure. Decisions must keep Karan able to help, keep
monthly costs low, and stay future-ready (multi-city, multi-builder,
AI vision/chat later).

Key constraints established 2026-09-22:
- All dollar math deterministic; LLM writes narrative only, never prices.
- Public users see aggregate ranges only — no $/sqft, no margins, no cost inputs.
- Estimates are immutable, versioned snapshots tied to the cost-data version.
- Schema must anticipate multi-city and multi-tenant expansion.
- No paid spend or external account creation without explicit approval.

## Decision

| Layer | Choice |
|---|---|
| Frontend | Angular + TypeScript (SPA) |
| Rendering / SEO | Build-time prerendering (SWA-friendly); full SSR via App Service/Container Apps only if needed — amendment 2026-09-22 |
| Hosting | Azure Static Web Apps (free tier) |
| Serverless API | Azure Functions, TypeScript (Node) |
| Database | PostgreSQL (managed; Azure Flexible Server or equivalent) |
| IaC | Azure Bicep |
| CI/CD | GitHub Actions |
| AI narrative | Meta API behind a provider abstraction (swappable) — decided 2026-09-22 |
| Auth | Magic link (passwordless email) |
| Lead ops | PostgreSQL as source of truth + auto-sync to Google Sheets |
| Property data | City of Calgary Open Data — Current Year Property Assessments API (Socrata), validated live 2026-09-22 |

Pure "no backend" was rejected: proprietary cost tables, margins, pricing
logic, secrets, lead PII, email integration, and LLM credentials cannot ship
in the client JS bundle. Serverless Functions satisfy this without an
always-on server.

**Amendment 2026-09-22 (SEO-first directive, Karan-confirmed):** SEO is a core
pillar, not an afterthought. Angular ships prerendered — never pure
client-side rendering — so crawlers, social scrapers, and AI agents see full
HTML + metadata. Build-time prerendering fits Static Web Apps and is ideal
for the programmatic community cost pages. Per-page titles/meta/OG tags,
sitemap.xml, robots.txt, Schema.org markup (FAQ, LocalBusiness), clean URLs,
Core Web Vitals budget, and llms.txt are M0 requirements. Programmatic
community pages are the core content engine; paid search (~$1.5k/mo test)
validates the funnel first, organic is the scale channel.

## Alternatives considered

1. **Razor Pages + HTMX + .NET** (per the original project brief) — rejected:
   Karan's comfort is Angular; a .NET API layer adds a second language without
   enough payoff at MVP scale. Revisit if .NET-specific needs arise.
2. **Angular + .NET API** — rejected for MVP for the same reason; TypeScript
   end-to-end keeps one language across UI, API, and IaC-adjacent tooling.
3. **Frontend-only / Supabase-style** — rejected: proprietary cost data and
   margins cannot live client-side; lead PII needs controlled server handling.
4. **Azure App Service B1 (~$130/mo)** (per the brief) — rejected for MVP:
   Static Web Apps free tier + Functions consumption plan covers expected
   traffic at a fraction of the cost. Revisit on real traffic.

## Data strategy (validated 2026-09-22)

- The City's **Current Year Property Assessments (Parcel)** dataset
  (`4bsw-nn7w`, Socrata API, free, updated 2026-09-22) returns per address:
  assessed value, neighbourhood, zoning/land-use designation, lot size,
  year built, and lot polygon geometry.
- MVP positions it honestly as **City-assessed value** — not a sold price or
  appraisal. Sold-price feeds (HonestDoor/MLS/CREA) deferred until licensing
  or partnerships justify it.
- Karan's 3–4 houses of historical cost data (Google Sheets, pending) seeds
  and calibrates the **build-cost tiers**; placeholder $/sqft values from the
  prototype are discarded.

## Agent-friendly distribution (added 2026-09-22, per Karan)

Feasly must be usable by AI agents (assistants like Muse), not just humans
in a browser. Rationale: as agents become a front door to services, an
agent-callable Feasly is a distribution moat — any assistant can generate a
Feasly estimate mid-conversation and route the lead.

Concrete implications:
- **Versioned public API** (`/api/v1`) with API keys: `get_property`,
  `estimate_project`, `submit_lead` — the same deterministic engine the web
  UI uses, returning structured JSON (schema-published).
- **MCP server** exposing those tools so assistants can call Feasly natively
  inside a conversation.
- Human web UI and agent API share one cost engine and one lead pipeline —
  no duplicated logic.
- API key management, rate limits, and usage metering from day one (metering
  enables future per-estimate billing to builders).
- Future hook: agent-driven lead follow-up (outbound), deferred past MVP.

## Cost estimate (MVP, monthly, provisional — not vendor-verified)

- Static Web Apps: free tier — $0
- Azure Functions: consumption, low traffic — ~$0
- PostgreSQL managed: ~CA$25–35
- Postmark (magic-link + lead emails): ~CA$15
- Domain: ~CA$2 amortized
- LLM narrative: pennies per estimate at low volume
- **Total: ~CA$50–80/mo**

## Open questions (need Karan)

1. Azure subscription + GitHub account/org: existing or create fresh?
2. Google Sheet with cost data: share when ready.
3. Magic-link auth confirmed as the only login?
4. Domain: verify feasly.com availability at registrar; fallback .ca or
   runner-up name if taken/expensive.
5. MVP scope: lean V1 (new build only) vs broader (reno + comparison + admin)
   — see `plan/BUILD_PLAN.md` milestone breakdown.

**Approval scope note:** approval covers architecture direction only — it does
not authorize account creation, spending, cloud provisioning, domain purchase,
or production deployment. Those need Karan's explicit go-ahead per item.

## Consequences

- One language (TypeScript) across the stack; Karan can read and help
  everywhere.
- Server-side cost engine stays proprietary; client bundle contains no
  pricing secrets.
- Bicep keeps infra reproducible and Azure-only; portable later if needed.
- Postgres schema designed with `city` / `tenant` columns from day one.
