# Feasly embed — install guide (embed/07)

Paste one script tag on any page of the builder's website and the Feasly
estimator appears, sandboxed and themed to the builder's brand.

## The snippet

```html
<script src="https://app.feasly.com/embed/v1/loader.js"
        data-builder="YOUR_TENANT_KEY"></script>
```

> **Hosting is a placeholder.** Until the serving path is decided, the loader
> is built from `apps/web/snippet/loader.js` and served from the same origin
> as the embed app (`/embed/v1/loader.js`). Self-hosting the file is fine too —
> the embed origin then defaults to the origin serving the file.

### Where to paste it

Put the tag wherever the estimator should appear. The iframe renders into the
tag's parent element by default:

```html
<div class="estimate-widget">
  <script src="https://app.feasly.com/embed/v1/loader.js"
          data-builder="abc123"></script>
</div>
```

Or target any container explicitly:

```html
<script src="https://app.feasly.com/embed/v1/loader.js"
        data-builder="abc123"
        data-target="#estimate-slot"></script>
<div id="estimate-slot"></div>
```

### Configuration attributes

| Attribute            | Required | Default                                   | Purpose                                                        |
| -------------------- | -------- | ----------------------------------------- | -------------------------------------------------------------- |
| `data-builder`       | yes      | —                                         | Tenant key from the Feasly dashboard.                          |
| `data-embed-origin`  | no       | origin serving `loader.js`                | Override when the embed app lives on a different origin.       |
| `data-target`        | no       | the script tag's parent                   | CSS selector of the container to render into.                 |
| `data-primary-color` | no       | builder's configured accent               | Live theme override, `#rrggbb` (validated by the embed shell).|
| `data-timeout`       | no       | `15000`                                   | ms to wait for the iframe before showing the fallback card.   |

### Required page context

- The page must be served over **HTTPS** in production (the embed app is
  HTTPS-only; mixed-content policies would block the iframe).
- No JavaScript framework is required on the host page — the loader is
  dependency-free and under 5 KB minified.

## What the loader does

1. Injects `<iframe src="https://app.feasly.com/embed/{tenantKey}">` with the
   sandbox flags `allow-scripts allow-forms allow-popups`.
2. Listens for `feasly:ready` from the iframe and auto-resizes it on
   `feasly:resize` messages.
3. If the iframe never signals ready (network failure, ad-blocker), replaces
   the slot with a fallback card — never a blank area.
4. Handles the magic-link token relay (`?feasly_rt=`): see below.

## Sandboxing

The iframe is sandboxed with exactly:

```
allow-scripts allow-forms allow-popups
```

`allow-same-origin` and `allow-top-navigation` are deliberately excluded
(TECH_PLAN §4.1): the embed cannot read the host page's DOM, cookies, or
storage, and cannot navigate the top-level page. Consequence: the iframe runs
at an **opaque origin** — see "Message protocol" for what that means for
`postMessage`.

## Message protocol

### Loader → iframe

| Type            | Payload                        | When                              |
| --------------- | ------------------------------ | --------------------------------- |
| `feasly:theme`  | `{ primaryColor: "#rrggbb" }`   | After `feasly:ready`, if `data-primary-color` is set. |
| `feasly:relay`  | `{ code: "<relay code>" }`      | After `feasly:ready`, if a `feasly_rt` code was captured. |

### Iframe → loader

| Type                   | Payload                                              | Loader behavior                              |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `feasly:ready`         | —                                                    | Clears the fallback timer; sends theme/relay. |
| `feasly:resize`        | `{ height: <px> }`                                   | Resizes the iframe (clamped 120–4000px).     |
| `feasly:estimate-start`| `{ addressKey?, address? }`                          | Re-dispatched as a DOM `CustomEvent` of the same name on the container (bubbles) — hook builder analytics here. |
| `FEASLY_AUTH_OK`       | `{ estimateId, leadScore }` (no PII)                  | Clears the stashed relay code.               |

### Origin validation

Because of the opaque-origin sandbox, `event.origin` is `"null"` for every
legitimate iframe message, so the loader validates the **sender window**
instead: a message is processed only when
`event.source === iframe.contentWindow`. Messages from any other window —
including spoofed messages crafted on the host page — are ignored.

Posts into the iframe go to the specific `iframe.contentWindow` reference with
targetOrigin `'*'`. A pinned targetOrigin can never match an opaque origin
(browsers throw or drop the message), so `'*'` is the only deliverable target;
it is safe because the post is point-to-point (never a broadcast) and is only
sent after the iframe proved its identity via `feasly:ready`.

## Token relay (`?feasly_rt=`)

Magic-link emails for embed leads point at the **builder's page** with a
single-use code: `https://builder.com/estimate?feasly_rt={code}`. The loader:

1. Reads `feasly_rt` from the page URL on load.
2. Stashes it in builder-origin `sessionStorage`.
3. Strips it from the visible URL with `history.replaceState` (visitors never
   see the code in the address bar).
4. Posts it to the iframe as `feasly:relay` once the iframe is ready; the
   iframe exchanges it server-side for a session (embed/06).
5. If the page reloads before the exchange, the stashed code is re-posted.
6. On `FEASLY_AUTH_OK` the code is cleared from storage.

## Fallback

If the iframe fails to load (network error, blocked by an extension, embed app
down), the slot shows:

> This estimator is temporarily unavailable — please contact the builder directly.

An invalid or revoked tenant key shows the same copy, rendered by the embed
shell itself inside the iframe.

## Theming

The builder's logo, name, and accent color come from the tenant config
(`GET /api/v1/embed/config`, embed/02) and are applied by the embed shell. The
optional `data-primary-color` attribute overrides the accent for the current
page view only (must be `#rrggbb`; anything else is ignored).

## Troubleshooting

### The estimator doesn't appear

- **Ad-blockers / privacy extensions** may block the iframe or the loader
  script. The fallback card appears automatically; ask the visitor to allow
  the embed origin.
- **CSP `frame-src`**: the host page's Content-Security-Policy must allow the
  embed origin, e.g. `frame-src https://app.feasly.com`. Without it the
  browser refuses to create the iframe and the fallback card shows.
- **CSP `script-src`**: must allow the origin serving `loader.js`.
- Check the browser console for `[feasly]` log lines — the loader logs its
  version on init and errors when misconfigured (missing `data-builder`,
  undeterminable embed origin, ready timeout).

### The iframe is the wrong height

The loader resizes the iframe from `feasly:resize` messages. If the height
sticks at the 640px default, the iframe's scripts are likely blocked (see
above) — the resize handshake never ran.

### Magic-link report doesn't open in the embed

The `feasly_rt` flow needs `sessionStorage` on the builder's origin. Private
browsing modes that block storage degrade gracefully (the code stays in the
URL until the iframe reads it — the loader still strips it on the next load).

## Versioning

The loader is versioned (`FEASLY_LOADER_VERSION` in `apps/web/snippet/loader.js`,
stamped into the built file). Install docs pin the **major** version:

```
https://app.feasly.com/embed/v1/loader.js
```

Backward-compatible fixes ship under the same `v1` path. A breaking change
bumps to `v2`, and the old path keeps serving until its announced sunset.
