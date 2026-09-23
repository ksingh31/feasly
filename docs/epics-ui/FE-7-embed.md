# FE-7 — Builder embed (white-label iframe)

**Goal:** the embed track that makes Feasly a SaaS product: a JS loader snippet on
the builder's site injects a sandboxed Feasly iframe running the same flow, themed
to the builder, with builder-aware lead gating.

## Stories (build order)

### FE7-001 — Embed shell: route, sandbox, theme handshake
**Size:** M
**Description:** `/embed/:tenant_key` route (CSR, `noindex`): reads tenant config
(`EmbedTenantConfig` — builder name, logo, primary color, allowed parent origin)
from the mock; `postMessage` handshake with the parent (theme tokens, auto-resize
via `ResizeObserver` → parent); sandboxed iframe attributes documented; no
third-party-cookie dependence; magic-link relay back to the builder page per the
locked embed auth (32-byte single-use relay code, 10-min life, `feasly_rt` param —
mock implements the shape, backend enforces the crypto later). Parent origin
allowlisted from tenant config (mock allows `*` only in dev; prod build asserts
an explicit origin).
**Acceptance criteria:**
- Iframe auto-resizes with content (no inner scrollbars) in the mock harness page.
- Theme handshake applies builder primary color to CTAs (visual test).
- Unknown `tenant_key` renders a clean "not configured" state (no stack trace).
- Prod build fails if tenant config allows `*` origin (CI assertion).
**Tests:** spec — handshake protocol, origin validation, resize messages; UI — themed shell.
**Mobile:** iframe responsive inside a mobile builder page; 390px harness test.
**Config notes:** handshake message shapes versioned in contracts.
**Dependencies:** FE0-001, FE2-001 (wizard reused inside the shell).

### FE7-002 — Embed lead gate + loader snippet page
**Size:** S
**Description:** Inside the embed shell, the S6 gate (FE4-001) renders the builder
consent line: "Your details go to {builder_name}, who may contact you about this
estimate." Plus a prerendered `/embed` marketing page for builders: the loader
snippet (`<script src=".../feasly-embed.js" data-tenant="KEY">`), integration steps,
"Powered by Feasly" badge spec (required placement documented).
**Acceptance criteria:**
- Consent line names the builder from tenant config; absent on the direct flow
  (FE4-001 cross-test).
- Snippet on the mock harness page boots the iframe (integration test).
- Badge placement documented with a visual example.
**Tests:** spec — consent-line conditional; UI — harness integration.
**Mobile:** consent line readable at 390px; snippet page code block scrolls horizontally
without breaking layout.
**Config notes:** snippet URL + badge spec from config.
**Dependencies:** FE7-001, FE4-001.
