# @feasly/api — Azure Functions (TypeScript, Node 22)

## Deploy layout (do not break)

`cd.yml` deploys this folder **as-is** via `Azure/functions-action` (`package: apps/api`):
no build step, no `npm install` on the server. Consequences:

- `host.json` must stay at this folder's root.
- Functions are discovered via the **v3 programming model** (`health/function.json` +
  `health/index.js`). Do not migrate to the v4 model without also changing `cd.yml`.
- `health/index.js` has **zero dependencies** and must stay that way — it is the
  deployed `/api/health` endpoint and runs without `node_modules` on the server.
- `estimate/` and `leads/` are the BE-3 trigger adapters (`function.json` +
  `index.js`, gitignored). Each `index.js` is a **self-contained esbuild bundle**
  produced by `npm run bundle:functions` — `cd.yml` rebuilds them before every
  Functions deploy, since the server has no `node_modules`.
- `src/` + `test/` compile to `dist/` (gitignored) for typechecking and tests;
  only the bundled trigger adapters ship to Azure.
- Runtime dependencies (`drizzle-orm`, `pg`, `zod`, `@feasly/cost-engine`,
  `@feasly/contracts`) exist solely to be bundled into the trigger adapters.

## Database

- `src/db/schema.ts` — `estimates` (insert-only snapshots), `leads`, and
  `analytics_events` (append-only, closed shape — no PII columns).
- `src/db/migrations/` — Drizzle-generated SQL. `cd.yml` runs
  `npm run db:migrate` (Key Vault password + discovered Postgres host) before
  every Functions deploy; generate new migrations with `npm run db:generate`.
- `POST /api/v1/estimate` persists the immutable estimate before returning;
  `POST /api/v1/leads` dedups on (normalized email, address) within the
  configured 90-day window — a repeat estimate for the same property
  updates the existing lead in place (name, phone, timeline, `lead_score`
  recomputed, `estimate_id` → newest; email/consent/notes/status history
  never clobbered) and emails the magic link immediately, reissuing it
  only when the lead has no live link. Store failures are sanitized —
  submitted PII never reaches logs.
- `GET /api/v1/magic-link/verify?token=…` resolves a magic-link token to
  its report — an old token for a re-estimated property resolves to the
  NEWEST estimate (`reportToken` is the presented token, the stable handle
  for the future `GET /api/v1/reports/{reportToken}`).
  `POST /api/v1/magic-link/reissue` idempotently resends the link
  (`{ sent: false }` when a live link exists or the email is unknown).
- `POST /api/v1/events` ingests first-party analytics events (story
  consumer/01): `{ event, route, ts, consent_ts }`, 202 Accepted. The
  `consent_ts` consent gate is enforced per event (missing or future-dated →
  400 `CONSENT_REQUIRED`); the event name must be in the contract allowlist;
  the payload shape is closed (strict — unknown keys rejected, so no PII can
  be stored); per-IP rate limit 300/min; storage is append-only
  (`analytics_events`).

## Layered pattern (non-negotiable — see `docs/epics-api/README.md`)

```
src/
├── routes/        # THIN: validate → call one service method → format response. Never db.
├── services/      # Logic lives here. `interface XxxService` + `createXxxService(deps)`.
├── db/            # Drizzle schema/client (BE-1). Imported ONLY by services/ + composition.ts.
├── middleware/    # errorHandler, correlationId, rateLimit, requestPipeline (BE0-003); requireAuth/requireRole (BE-4).
├── lib/           # Pure utils: no I/O, no db. Unit-tested.
├── config.ts      # The ONLY module that reads process.env (zod-validated, BE0-002).
└── composition.ts # The ONLY place concretes are constructed.
```

Enforced by `test/boundaries.test.ts` (fails the PR on violation) and covered by
`test/composition.test.ts` + `test/config.test.ts`.

## Scripts

- `npm run build -w @feasly/api` — `tsc -b` (also covered by root `tsc -b` via project references)
- `npm run test -w @feasly/api` — vitest
- `npm run db:generate -w @feasly/api` — generate a Drizzle migration from schema changes
- `npm run db:migrate -w @feasly/api` — apply migrations (`DATABASE_URL` or `POSTGRES_*`)
- `npm run bundle:functions -w @feasly/api` — esbuild the trigger adapters into `estimate/index.js` + `leads/index.js`
