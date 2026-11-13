# Design & UX reviews

| Date | Area | File |
|---|---|---|
| 2026-11-13 | Consumer site (funnel, report, SEO pages, embed) | [2026-11-13-consumer.md](2026-11-13-consumer.md) |
| 2026-11-13 | Builder portal | [2026-11-13-builder.md](2026-11-13-builder.md) |
| 2026-11-13 | Admin console | [2026-11-13-admin.md](2026-11-13-admin.md) |

Method: a local Playwright run captured every route at 1440×900 and 390×844
(loaded + empty data, every drawer/modal/confirm open), plus axe-core and a
real walk of the consumer flow against live City data. Admin/builder screens
used contract-shaped mock API data; no real leads, emails or payments.
Screenshot paths (`audit/shots/...`) refer to that local capture run and are
not committed.

Functional bugs from these reviews are GitHub issues #472–#479 and #483–#490.
Design stories are written from these files after owner review.
