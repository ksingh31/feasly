# Feasly agent API and MCP: developer guide

Status: **invite-only beta, free** (owner decision 2026-11-15, issue #738).
Everything here describes what the API does today. The OpenAPI spec at
`GET /api/v1/openapi.json` is the reference for every request and response.

Dollar figures come from Feasly's deterministic cost model, not from AI. No
accuracy percentage is claimed: figures are illustrative ranges until they
are calibrated against builder data. Pass the `disclaimer` from each estimate
on to your users.

## 1. Get a key

Keys are issued by the Feasly team during the beta. There is no self-serve
sign-up yet.

1. Email the Feasly team using the contact route on the `/developers` page.
   Include your name, your company, what you are building, and the scopes
   you need (`property:read`, `estimate`, `lead`).
2. We issue a **sandbox** key (`feasly_test_…`) first. When your
   integration works, ask for a **live** key (`feasly_live_…`).
3. The key is shown to us **once** at issuance, and we send it to you over a
   private channel. Feasly stores only a hash, so a lost key can't be
   recovered. We issue a new one instead.

Key lifecycle:

- **Rotation**: ask us to rotate. The old key stops working right away. Plan
  a short cut-over.
- **Revocation**: a revoked key gets `401 INVALID_API_KEY` from then on.
- **Leaked key**: tell us at once. We revoke it and issue a new one. Never
  put a key in client-side code, a public repo, or a prompt.
- **Expiry**: beta keys don't expire, but we may rotate them before general
  availability.

Send the key as a Bearer token on every call:

```http
Authorization: Bearer feasly_test_xxxxxxxx
```

## 2. Quickstart: REST

All paths include the Azure Functions `/api` prefix.

```bash
BASE=https://<feasly-host>/api
KEY=feasly_test_xxxxxxxx

# 1. Find the property
curl -s "$BASE/v1/properties/autocomplete?q=1600%2090%20av" -H "Authorization: Bearer $KEY"
curl -s "$BASE/v1/properties/lookup?addressKey=<addressKey>" -H "Authorization: Bearer $KEY"

# 2. Estimate a new build (property values come from the lookup)
curl -s -X POST "$BASE/v1/estimate" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"projectType":"new_build",
       "property":{"addressKey":"<addressKey>","assessedLandValue":400000,"lotSizeSqft":4500,"zoning":"R-C2"},
       "scope":{"buildSqft":2000,"tier":"standard"}}'
```

## 3. Quickstart: MCP

- Endpoint: `POST /api/mcp/v1`, Streamable HTTP, stateless JSON-RPC.
- Auth: `Authorization: Bearer <key>`. Each tool needs its scope.
- Tools: `get_property` (`property:read`), `estimate_project` (`estimate`),
  `submit_lead` (`lead`).

For any MCP client that supports remote HTTP servers with custom headers
(Claude, MCP Inspector and others), set the URL to
`https://<feasly-host>/api/mcp/v1` and add the `Authorization` header. Then
call `tools/list` to check the connection.

## 4. Submitting leads: consent attestation

A lead means a real person will be contacted. When you submit one, through
REST `POST /api/v1/leads` with your key or the MCP `submit_lead` tool, you
are acting for that person. You must attest their consent:

```json
{
  "estimateId": "<from the estimate>",
  "email": "person@example.com",
  "name": "Their name",
  "timeline": "6-12mo",
  "marketingConsent": false,
  "consent": true,
  "consentVersion": "api-lead-2026-11-15-draft"
}
```

- `consent: true` confirms the wording below, and `consentVersion` names
  the version you agreed to. When the wording changes, the version changes,
  and the old version is rejected until you re-attest.
- A missing or false `consent`, or a stale `consentVersion`, gets
  **400 `CONSENT_REQUIRED`**. Nothing is stored.
- Feasly stores the version, the key that attested, and the time with the
  lead.

Current wording (draft, pending legal review; source of truth:
`docs/legal/approved-copy.md` "API lead consent attestation"):

> I confirm that the person named in this lead asked to be contacted about
> their estimate, agreed that Feasly and builders associated with Feasly may
> contact them about it, and was told they can opt out anytime.

Set `marketingConsent: true` only if the person also agreed to marketing
email.

**Review queue.** During the beta, every lead submitted with a key is held
for review by the Feasly team before anyone is contacted. The response is
`201` with `magicLinkSent: false` and no `reportToken`. Leads from a sandbox
key are marked as sandbox data and are never emailed. Submitting the same
email and property again within 90 days returns the existing `leadId` and
changes nothing.

## 5. Limits and quotas

Each key has three limits, all counted on accepted calls (rejected 429s
don't count):

| Limit | Beta default | Resets |
|---|---|---|
| Per minute | 100 requests | sliding 60-second window |
| Per day | 100 requests | 00:00 UTC |
| Per month | 2,000 requests | the 1st, 00:00 UTC |

REST and MCP calls share the same counts. The limits hold across all Feasly
server instances because they're counted in the database.

Over a limit, you get `429` with RFC 7807 `application/problem+json` and a
`Retry-After` header (seconds):

- `code: "RATE_LIMITED"`: the per-minute window. Headers:
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- `code: "QUOTA_EXCEEDED"`: the daily or monthly quota. Headers:
  `X-Quota-Period` (`day` or `month`), `X-Quota-Limit`,
  `X-Quota-Remaining`, `X-Quota-Reset` (epoch seconds).

Need more? Ask us. The beta has no paid tiers.

## 6. Errors

Every error is `application/problem+json` with `code`, `message`,
`retryable` and `correlationId`. Quote the `correlationId` when you report
a problem.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The body failed validation. `message` names the field. |
| 400 | `CONSENT_REQUIRED` | A lead without a valid consent attestation. |
| 401 | `INVALID_API_KEY` | Missing, unknown, revoked or rotated key. |
| 429 | `RATE_LIMITED` / `QUOTA_EXCEEDED` | See section 5. |
| 5xx | `INTERNAL_ERROR` / `DEPENDENCY_UNAVAILABLE` | Retry with backoff when `retryable` is true. |

MCP calls return JSON-RPC errors for protocol problems. A tool your key has
no scope for returns a tool error naming the missing scope. A call without a
Bearer header gets HTTP 401 with JSON-RPC code `-32001`. (Scope enforcement
on the REST endpoints is tracked in #802.)

## 7. Sandbox

- Sandbox keys (`feasly_test_…`) call the same endpoints.
- Leads they submit are marked as sandbox data. They're never emailed and
  are covered by the 30-day sandbox purge.
- Quotas apply to sandbox keys too.

## 8. Versioning

URL versioning (`/v1/`). A breaking change ships under a new version, with
notice on the old one (see the OpenAPI `info.description`). The changelog,
deprecation headers and the OpenAPI breaking-diff guard are tracked in #765
and the follow-up stability work.

## 9. Support

Use the contact route on the `/developers` page, and include the
`correlationId` from the failing response. A dedicated support inbox comes
with the email/ops-inbox story.
