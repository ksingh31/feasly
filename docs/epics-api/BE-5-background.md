# BE-5 — Background queues (Storage Queues + triggers)

No synchronous SMTP, PDF rendering, or Sheets calls in request paths — everything
slow goes through a durable queue with retries and poison-queue dead-lettering.

### BE5-001 — Queue infrastructure
**Size:** M — Queue client in `composition.ts` (queue names from config);
`enqueue(queue, message)` helper on a `QueueService` interface. Queue-triggered
functions with exponential-backoff retry (config) and poison queues.
**Tests:** handler unit tests with faked queues; poison message lands in
`-poison` after max retries.

### BE5-002 — Email sender (Postmark when ready)
**Size:** S — `send-email` queue handler. Provider behind `IEmailProvider`;
V1 ships a logging stub (no credentials needed); swapping in Postmark is a
one-story change later. Used by magic-link + share + callback notifications.

### BE5-003 — Sheets sync + PDF
**Size:** M — Lead rows appended to Google Sheets (source of truth stays
Postgres; Sheets is Karan's daily view). Report PDF rendered from the snapshot
(data only — the PDF layout story belongs to a later epic).
**Dependencies:** BE-1 (data), BE-4 (auth for report reads).
