# Approved legal copy — DRAFT (LEGAL_REVIEW_PENDING)

> **Status: draft — pending lawyer review.** Nothing in this file has been
> approved. The API ships draft copy from `apps/api/src/lib/legal-copy.ts`
> (each block structurally marked `draft-pending-lawyer`) until this file is
> replaced with lawyer-approved text and the diff test
> (`apps/api/test/privacy-legal-copy.test.ts`) is pointed at it.
>
> Owner of this file: the privacy/terms story (legal/01). The PIPEDA
> endpoints story (legal/02) only defines the attach point — it does not
> write legal copy.

## How approval works

1. The lawyer reviews and rewrites the sections below.
2. The approved text replaces this file (the `LEGAL_REVIEW_PENDING` banner
   is removed by that commit).
3. The diff test is updated to byte-compare the API's copy constants
   against the approved sections — any drift fails the build.

## Sections awaiting approval

### Data-retention schedule

Source of truth while draft: `RETENTION_RULES_DRAFT` in
`apps/api/src/lib/legal-copy.ts`.

_(lawyer: confirm or rewrite each row — leads, anonymized estimate
snapshots, magic-link hashes, erasure requests, privacy audit log.)_

### Erasure consequences statement

Source of truth while draft: `ERASURE_CONSEQUENCES_DRAFT` in
`apps/api/src/lib/legal-copy.ts`.

_(lawyer: confirm the consequences wording shown to the user before they
confirm deletion — report links stop working, shares revoked, PII deleted,
anonymized aggregates retained.)_

### CASL consent wording

_(lawyer: the exact opt-in wording; must byte-match the consent line on
`/privacy` and in the lead-gate UI once approved.)_

> **Status: draft-pending-lawyer.** The wording in the block below is the
> current draft. When counsel approves (or rewrites) it, update this block —
> the HRD-05 CASL diff test (`apps/web/tools/check-casl-copy.mjs`) keeps the
> app's `caslLabel` byte-identical to it.

```text
It’s okay to email me occasional updates about Feasly and Calgary infill costs. I can unsubscribe anytime.
```
