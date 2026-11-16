/**
 * #725 — thin builder notification-preferences route: 401 without a
 * session; the session (never the request) is passed to the service.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBuilderNotificationsRoute } from '../src/routes/builder/notifications.route';
import { HttpError } from '../src/middleware/errors';

const RESPONSE = {
  channel: 'email' as const,
  preferences: { newLeadEmail: true, needsYouDigest: false, billingEmail: true },
  role: 'builder_member' as const,
  canDisableBillingEmail: true,
};
const SESSION = {
  email: 'member@elite.example',
  tenantKey: 'elite',
  builderId: 'b-elite',
  viewAs: null,
};

function setup(session: typeof SESSION | null) {
  const getPreferences = vi.fn(async () => RESPONSE);
  const updatePreferences = vi.fn(async () => RESPONSE);
  const route = createBuilderNotificationsRoute({
    notifications: { getPreferences, updatePreferences },
    builderGuard: { getBuilderSession: async () => session },
  });
  return { route, getPreferences, updatePreferences };
}

describe('builder notifications route (#725)', () => {
  it('401 without a builder session', async () => {
    const { route, getPreferences, updatePreferences } = setup(null);
    for (const call of [
      () => route.getPreferences({}),
      () => route.updatePreferences({}, { newLeadEmail: false }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
    }
    expect(getPreferences).not.toHaveBeenCalled();
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('passes the session and body through to the service', async () => {
    const { route, getPreferences, updatePreferences } = setup(SESSION);
    expect(await route.getPreferences({ cookie: 'x' })).toEqual(RESPONSE);
    expect(getPreferences).toHaveBeenCalledWith(SESSION);
    await route.updatePreferences({ cookie: 'x' }, { needsYouDigest: true });
    expect(updatePreferences).toHaveBeenCalledWith(SESSION, { needsYouDigest: true });
  });
});
