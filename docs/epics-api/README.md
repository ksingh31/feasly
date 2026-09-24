# Feasly backend epics — `apps/api` (Azure Functions, TypeScript)

**Stack (locked 2026-09-23):** TypeScript on Azure Functions (Node 22), Drizzle ORM,
PostgreSQL 16 (already provisioned), Vitest, zod. The deterministic cost engine lives
in `packages/cost-engine` (pure TS, zero I/O) and is shared by the API and the future MCP
server. API shapes are imported from `@feasly/contracts` — the backend cannot drift
from the contracts; a shape change is a compile error, not a runtime surprise.

**Epics:** BE-0 foundation → BE-1 data → BE-2 engine → BE-3 public endpoints →
BE-4 auth & authorization → BE-5 background queues → BE-6 secured dashboard →
BE-7 MCP server → BE-8 hardening.

## Layered pattern (the C# discipline, in TypeScript — non-negotiable)

```
src/
├── routes/        # THIN: parse/validate input → call service → format response.
│                  # Never touch the db. Never contain business logic.
├── services/      # Logic lives here ("composition services"). Each service exposes
│                  # an `interface XxxService` + `createXxxService(deps)` factory.
│                  # Only services (and the composition root) may import from db/.
├── db/            # Drizzle schema, migrations, client construction. Nothing else
│                  # imports this except services and composition.ts.
├── middleware/    # requireAuth, requireRole, rateLimit, errorHandler, correlationId
├── lib/           # Pure reusable utils (no I/O, no db). Unit-tested.
├── config.ts      # zod-validated env → typed config. Fails fast at startup.
└── composition.ts # Wires everything: config → db → services → routes.
                  # The ONLY place `new`/concrete constructors appear.
```

**Rules:**
- Routes depend on service *interfaces*, never implementations, never `db`.
- `db/` is imported only by `services/` and `composition.ts` — enforced by a
  boundary test that fails the PR on violation.
- Every tunable value (URLs, limits, timeouts, flags, TTLs) comes from `config.ts`.
  A CI grep fails the PR on hardcoded literals outside `config.ts`.
- Errors are RFC 7807 ProblemDetails matching the `ApiError` contract.
- Auth: public routes are open + rate-limited; dashboard/admin routes go through
  `requireAuth` → `requireRole('builder' | 'admin')`. JWT in httpOnly cookie,
  issued by magic-link verification.

## Non-negotiable rules (every story — same as frontend)

- **PR per story.** Branch `feat/<story-id>-<slug>` → PR → green CI → merge.
- **Tests before merge:** unit (services with db faked at the interface boundary),
  route tests (services stubbed), contract-conformance (response JSON matches
  `@feasly/contracts` fixtures).
- **Best-practices PR review:** every story PR is reviewed against this README's
  patterns (layering, interfaces, no-hardcode, auth on secured routes) before merge.
- **Per-story audit + summary:** after finishing, re-read the acceptance criteria,
  note what was missed / carried forward, and give the 2–3 sentence summary
  (what was built, what it means, the technical side).
- **Current, widely-used packages only.** No abandoned or pre-1.0 novelties.

## Global Definition of Done

- [ ] Unit tests pass (services, lib, middleware)
- [ ] Route tests pass against stubbed services
- [ ] Contract-conformance: response fixtures validate against `@feasly/contracts`
- [ ] Boundary test: routes never import `db/`; no hardcoded literals outside `config.ts`
- [ ] Secured routes return 401 without credentials, 403 with the wrong role
- [ ] `npm run build -w @feasly/api` green; no `any`, no unhandled rejections
