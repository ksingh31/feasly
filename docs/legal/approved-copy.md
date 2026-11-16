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

_(lawyer: the exact consent wording; must byte-match the required consent
checkbox in the lead-gate UI once approved.)_

> **Status: draft-pending-lawyer.** The wording in the block below is the
> current draft (contact model decided 2026-09-27: Feasly and builders
> associated with us may contact the lead about their estimate; the lead can
> opt out anytime). When counsel approves (or rewrites) it, update this
> block — the HRD-05 CASL diff test (`apps/web/tools/check-casl-copy.mjs`)
> keeps the app's `consentLabel` byte-identical to it.

```text
I agree to the Terms and Privacy Policy, and that Feasly and builders associated with us may contact me about my estimate. I can opt out anytime.
```

### CASL waitlist consent wording

_(lawyer: the exact consent wording for the "tell me when it's ready"
waitlist capture — renovation estimates and other cities, issue #520; must
byte-match the required consent checkbox in the waitlist UI once approved.)_

> **Status: draft-pending-lawyer.** Owner decision 2026-11-15 (option (a),
> the lead-gate pattern): a required, unticked checkbox with the wording
> below; "Privacy Policy" links to the privacy page. Same status as the
> lead-gate consent above. The API stores `consent_ts` and
> `consent_version` (`WAITLIST_CONSENT_VERSION` in
> `apps/api/src/lib/legal-copy.ts` — bump it when this wording changes) and
> rejects a signup without consent. `apps/web/tools/check-casl-copy.mjs`
> keeps the app's `copy.waitlist.consentLabel` byte-identical to it.

```text
I agree to the Privacy Policy and that Feasly may email me when this launches. I can unsubscribe anytime.
```

### Platform agreement (builder clickwrap)

_(lawyer: the platform agreement every builder org accepts before any money
action — commission rate, attribution window, reporting duty; issue #722.)_

> **Status: draft-pending-lawyer.** Owner decision 2026-11-15: the copy is
> draft-pending-counsel; the clickwrap mechanism ships with neutral draft
> text. Source of truth while draft: `PLATFORM_AGREEMENT_DRAFT` in
> `apps/api/src/lib/legal-copy.ts`, served by `GET /api/v1/builder/agreement`
> (the `document` field) together with its version. The current version is
> the API config `PLATFORM_AGREEMENT_VERSION` (default
> `PLATFORM_AGREEMENT_VERSION` in the same file). When counsel approves (or
> rewrites) the text: replace the draft, bump the version (every builder org
> then accepts again; older acceptances stay on record), set the document
> status to `approved` and remove the `draft-pending-lawyer` marker.

### Builder-partner disclosure (builder-matching explainer + FAQ)

_(lawyer: confirm or rewrite the referral-commission disclosure shown under
the lead-gate form, in the report's next steps, and in the FAQ answers
"How do builder introductions work?" / "Is Feasly a home builder?")_

> **Status: draft-pending-lawyer.** Owner decision 2026-11-15 (#878,
> option (a)): the copy matches the partner model. Leads from Feasly's own
> site go to the builder partner(s) named on How it works, who pay a
> referral commission on signed contracts. Source of truth while draft:
> `copy.builderMatching.paragraphs` in
> `apps/web/src/app/core/config/app-config.defaults.ts` (mirrored in
> `apps/web/public/assets/config/app-config.json`). Neutral-matching claims
> ("no favourites", "no paid placement", "matches on project fit", "rank
> builders", "hand-pick") are banned by
> `apps/web/tools/check-banned-phrases.mjs`. Embedded estimators on a
> builder's own site don't show this explainer: the lead goes to that builder.

```text
Feasly is an independent estimator. We don’t build homes. If you ask to be contacted, leads from Feasly’s own site go to our builder partner(s), listed on How it works. A partner pays Feasly a referral commission only if you sign a contract with them. It never changes your estimate, and you’re never obliged to hire anyone. You can opt out anytime.
```
