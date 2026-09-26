/**
 * Shared dispatch for the admin-calibration Function adapter (admin/09).
 *
 * Reuses the admin-leads dispatch: identical CORS, composition caching,
 * correlation ID, and problem-details handling. Admin authentication is
 * enforced inside the route via the session-cookie AdminGuard (admin/01).
 */
export {
  dispatchAdminLeads as dispatchAdminCalibration,
  type FunctionContext,
  type FunctionRequest,
} from '../admin-leads/shared';
