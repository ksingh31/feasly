# BE-6 — Secured dashboard endpoints

**Everything here is behind `requireAuth` + `requireRole`. Public traffic can
never reach these routes — the BE4-002 registry test enforces it.**

### BE6-001 — Builder dashboard API
**Size:** M — `GET /api/v1/dashboard/leads` (tenant-scoped, paginated, filter by
status), `PATCH /api/v1/dashboard/leads/:id` (status updates, audit-logged),
`GET /api/v1/dashboard/stats` (counts, conversion funnel — aggregates only, no
PII beyond what the builder already owns). Tenant isolation enforced in the
service layer via the `tenantId` claim.
**Tests:** cross-tenant access attempts → 403; pagination contract.

### BE6-002 — Admin API
**Size:** M — `requireRole('admin')`: community cost-table management (feeds the
engine config), estimate snapshot inspection, audit-log reads, feature-flag
toggles. Every mutation audit-logged with the admin principal.
**Tests:** builder role → 403 on all admin routes.
**Dependencies:** BE-1, BE-4.
