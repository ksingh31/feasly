# Google Ads offline-conversion upload from lead rows

Status: **documentation only** (#814; decision on #702: Google Ads goes first,
no third-party tag, no CSP change). Building the upload is a follow-up story.

## Why server-side

The site loads no third-party scripts (`check-security-headers.mjs`), and the
analytics events sit behind the opt-in. Ad-platform conversions therefore come
from **our own lead rows**, uploaded after the fact. The browser never talks to
Google.

## What a lead row carries (since #814)

| Column (`leads`) | Sheet column | Meaning |
|---|---|---|
| `source_utm_source` | `utm_source` | e.g. `google` |
| `source_utm_medium` | `utm_medium` | e.g. `cpc` |
| `source_utm_campaign` | `utm_campaign` | Campaign name from the ad's final-URL suffix |
| `source_utm_term` | `utm_term` | Keyword, if the suffix sets it |
| `source_utm_content` | `utm_content` | Ad variant, if set |
| `source_click_id_type` | `click_id_type` | Which click-id parameter was on the URL (`gclid`, `gbraid`, `wbraid`, …), **never the value** |
| `created_at` | `created_at` | Conversion time |

The values come from the visitor's first load, are sent with the gate submit
(`LeadRequest.source`), are stored once when the lead is created, and are
mirrored to the Sheets export. Values that fail the length check (100 chars)
or the PII check (`@`, `$`, query-string characters) are stored as NULL.

**One-time ops step when #814 deploys:** the Sheets sync only writes data rows
(row 2 down); it never writes the header row. On the live lead Sheet, add the
six labels `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`, `click_id_type` to cells **U1:Z1** by hand (the order of
`SHEET_HEADERS` in `apps/api/src/services/sheets/google-sheets-client.ts`).
Until then the values land under blank headers, and anything that reads these
columns by name — including this upload — won't find them.

## Upload format

Google Ads offers two ways to import offline conversions. Download the current
template from the Google Ads UI (Goals → Conversions → Uploads) when this is
built. Column names change over time, so don't hard-code them from this note.

1. **Click-ID import.** One row per conversion: Google Click ID, conversion
   name, conversion time (with time zone), and optional value and currency.
   **We can't use this today.** We record only the click-id *type*. Storing the
   `gclid` value would mean a new nullable column plus an owner and privacy
   decision. Raise it as its own issue if we need it.
2. **Enhanced conversions for leads.** One row per conversion: the lead's
   normalised email (trimmed, lower-cased, then SHA-256 hashed before upload),
   conversion name, and conversion time. This matches on Google's side with no
   click id, so it fits what we store. Before using it, the owner needs to
   confirm that the privacy policy covers sharing hashed contact details with
   an ad platform (`needs:karan`: legal copy).

Either way, select the rows with `source_utm_source = 'google'` (optionally
also `source_click_id_type IS NOT NULL`), excluding `quarantined`, `discarded`
and `sandbox` rows. Respect `contact_opt_out_at` / `unsubscribed_at` if the
privacy review says to.

## Measuring the test without the upload

`GET /api/v1/admin/funnels?utm_source=google&utm_campaign=<name>` returns the
funnel (landing view → address selected → preview → gate view → gate convert →
report open) for one campaign. With no filter, `bySource` breaks the funnel
down per (source, campaign). These counts cover opted-in visitors only.
