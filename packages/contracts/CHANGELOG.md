# @feasly/contracts — changelog

## Contract-change policy

These types are the frozen seam between the Angular UI, the mock harness, and the
real backend. Changing them has a cost, so:

- **Additive, optional fields** (new `foo?: T`): minor version bump, entry below.
- **Any breaking change** (rename, removal, optionality flip, type narrowing):
  major version bump + a migration note below. UI and API must agree on the same
  **major** before either ships.
- **Never** widen a type to `any` to "unblock" something — the no-`any` lint exists
  precisely to stop that.

## 0.1.0 — 2026-09-23

Initial frozen UI contracts (FE0-001): `common`, `property`, `estimate`, `lead`,
`magic-link`, `report`, `callback`, `share`, `events`, `embed`, `community`, `error`,
plus the `registry` (contract list + version) consumed by the FE0-003 mock-harness
conformance test.
