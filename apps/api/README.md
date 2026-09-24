# @feasly/api — Azure Functions (TypeScript, Node 22)

## Deploy layout (do not break)

`cd.yml` deploys this folder **as-is** via `Azure/functions-action` (`package: apps/api`):
no build step, no `npm install` on the server. Consequences:

- `host.json` must stay at this folder's root.
- Functions are discovered via the **v3 programming model** (`health/function.json` +
  `health/index.js`). Do not migrate to the v4 model without also changing `cd.yml`.
- `health/index.js` has **zero dependencies** and must stay that way — it is the
  deployed `/api/health` endpoint and runs without `node_modules` on the server.
- `src/` + `test/` compile to `dist/` (gitignored); the output is inert in the
  deployed zip until a later story wires trigger adapters to it (BE-3).
- This story adds **no runtime dependencies** for exactly this reason.

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
