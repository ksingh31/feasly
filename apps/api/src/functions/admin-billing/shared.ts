/**
 * Shared dispatch for the admin-billing Function adapter (billing/03
 * follow-on — /admin/billing).
 *
 * Reuses the admin-leads dispatch: identical CORS, composition caching,
 * correlation ID, and problem-details handling. Admin authentication is
 * enforced inside the route via the session-cookie AdminGuard (admin/01).
 */
export {
  dispatchAdminLeads as dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from '../admin-leads/shared';
