# Feasly

Deterministic infill build-cost estimator for Calgary — starting as a
white-label **builder SaaS embed**, with a neutral **marketplace** to follow.

## Layout

| Path | What lives here |
|---|---|
| `apps/web` | Angular consumer site + `/embed` route + builder dashboard (epic 03) |
| `apps/api` | Azure Functions (TypeScript), versioned `/api/v1` (epics 07, 10) |
| `packages/cost-engine` | Deterministic cost engine — pure TS, zero I/O, **never ships to the browser** (epic 02) |
| `packages/contracts` | Shared DTOs + validation schemas for REST and postMessage |
| `packages/embed-loader` | Vanilla JS `<5KB` loader snippet for builder sites (epic 05) |
| `packages/mcp` | MCP server over the cost engine (epic 07) |
| `infra/bicep` | Azure infrastructure as code (Static Web Apps, Functions, Postgres, Key Vault) |
| `docs/plan` | Technical plan, coding patterns, epics/stories, user validation |
| `docs/adr` | Architecture decision records |

## Quick start

```bash
nvm use        # Node 22
npm install
npm run build  # tsc -b across project references
```

## Invariants

- All dollar figures come from `@feasly/cost-engine` (deterministic math).
  LLMs write narrative only — never prices.
- PostgreSQL is the source of truth; Google Sheets is a read replica.
- Estimates are immutable, versioned snapshots.
- See `docs/plan/TECH_PLAN.md` and `docs/adr/ADR-001-architecture.md`.
