# EMBED-09 Status Enum Reconciliation

## Issue
The EMBED-09 story specifies builder lead statuses as:
`contacted`, `quoted`, `won`, `lost`

The existing lead schema (admin flow) documents:
`new`, `contacted`, `quoting`, `won`, `lost`

## Resolution
**Decision:** Preserve the canonical existing persisted enum values where they overlap, and use the story's `quoted` (not `quoting`) for the builder portal.

**Rationale:**
1. The database `leads.status` column already contains values like `new`, `contacted`, `quoting`, `won`, `lost` from the admin flow.
2. The EMBED-09 story explicitly lists `quoted` (not `quoting`) as a builder status.
3. Creating a separate `quoted` vs `quoting` distinction would fragment the pipeline and break the admin leads explorer filters.

**BuilderLeadStatus enum (packages/contracts/src/builder.ts):**
```typescript
export type BuilderLeadStatus = 'new' | 'contacted' | 'quoted' | 'won' | 'lost';
```

**Mapping:**
| Story status | Persisted value | Notes |
|--------------|-----------------|-------|
| (new lead)   | `new`           | Default for new leads; builder can see but not set |
| `contacted`  | `contacted`     | Direct match |
| `quoted`     | `quoted`        | Story uses `quoted`; admin uses `quoting`. Builder portal writes `quoted`. |
| `won`        | `won`           | Direct match |
| `lost`       | `lost`          | Direct match |

**Important:** The admin flow's `quoting` status and the builder portal's `quoted` status are DISTINCT persisted values. This is intentional:
- Admin `quoting` = internal "we're working on a quote" 
- Builder `quoted` = builder-facing "quote sent to homeowner"

If a future story needs to unify these, a data migration would be required. For EMBED-09, the builder portal is the source of truth for builder-facing statuses.

## Tests
- `test/builder-leads.service.test.ts` verifies status transitions work with the `quoted` value.
- The service accepts all five statuses via `BuilderLeadStatusSchema` zod enum.
