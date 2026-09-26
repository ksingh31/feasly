/**
 * Thin report routes (phase-2 wiring). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * Both endpoints are public-token endpoints (the magic-link report token is
 * the credential) — the Function adapters apply the public rate limiter.
 * The return type is the contracts `ReportSnapshot` in both cases.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { ReportSnapshot } from '@feasly/contracts';
import type { ReportService } from '../services/report.service';

export interface ReportRouteDeps {
  readonly reports: ReportService;
}

export interface ReportRoute {
  /** Latest report snapshot for a report token. */
  get(reportToken: string): Promise<ReportSnapshot>;
  /** Append a tier/sqft what-if revision for a report token. */
  createRevision(reportToken: string, requestBody: unknown): Promise<ReportSnapshot>;
}

export function createReportRoute(deps: ReportRouteDeps): ReportRoute {
  return {
    get: (reportToken: string): Promise<ReportSnapshot> =>
      deps.reports.getReport(reportToken),
    createRevision: (
      reportToken: string,
      requestBody: unknown,
    ): Promise<ReportSnapshot> =>
      deps.reports.createRevision(reportToken, requestBody),
  };
}
