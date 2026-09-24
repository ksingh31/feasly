# BE-2 — Deterministic cost engine (`packages/engine`)

The engine is the product's trust core: every dollar figure the user ever sees
comes from here. Pure TypeScript, zero I/O, zero framework imports.

### BE2-001 — Pure engine v1
**Size:** L
**Description:** `packages/engine`: `runEngine(input: EngineInput): EngineOutput`
where `EngineInput`/`EngineOutput` are built from `@feasly/contracts` types.
Rules: no `Date.now()` (clock injected), no randomness (seed injected), no
`process.env`, no imports outside `contracts` and pure stdlib. Engine version
stamped on every output (`engine_version: "1.0.0"`); the version bumps only via
an explicit story + fixture regeneration. Cost tables (per-sqft rates, tier
multipliers) come from injected config data, never literals in the math.
**Acceptance criteria:**
- Same input → byte-identical output, 10,000 runs (property test).
- Output figures validate against the contract `Figure` shapes.
- No network/fs/env access possible (boundary test on imports).
**Tests:** fixture suite (hand-computed cases); property test for determinism.
**Dependencies:** FE0-001 (contracts).

### BE2-002 — Pre-gate blur guarantee
**Size:** S
**Description:** The engine exposes `previewOf(output)` which returns the same
shape with every figure replaced by `{ blurred: true }` and rows emptied. The
public estimate endpoint (BE3-002) can only return preview output pre-gate —
enforced by the type: the route's return type is `PreviewEstimateResponse`, so
returning real figures is a compile error.
**Tests:** preview output contains zero numeric figures (deep assertion).
**Dependencies:** BE2-001.
