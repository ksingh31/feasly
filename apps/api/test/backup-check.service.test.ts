/**
 * Backup freshness check tests (admin/06 `backup_missed`).
 *
 * The ARM + IMDS HTTP calls are faked via an injected fetchImpl — no
 * network, no Azure. Covers: healthy chain, stale restore point, low
 * retention, missing restore point, IMDS failure, ARM error status.
 * None of the tests assert on secrets: the token is opaque to the service.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBackupCheckService } from '../src/services/backup-check.service';

const NOW = new Date('2026-09-26T00:00:00Z');
const DEPS = {
  subscriptionId: 'sub-123',
  resourceGroup: 'rg-feasly-dev',
  serverName: 'feasly-dev-pg-4fhkep',
  minRetentionDays: 7,
  maxStaleHours: 48,
  imdsTokenUrl: 'http://169.254.169.254/metadata/identity/oauth2/token',
  armBaseUrl: 'https://management.azure.com',
  clock: () => NOW,
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function errStatus(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response;
}

/** Fake fetch: IMDS returns a token, ARM returns the given backup block. */
function fakeFetch(backup: unknown, armStatus = 200) {
  return vi.fn(
    async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('169.254.169.254')) {
        return okJson({ access_token: 'fake-token' });
      }
      expect(url).toContain('/flexibleServers/feasly-dev-pg-4fhkep');
      expect(url).toContain('api-version=2023-12-01-preview');
      return armStatus === 200
        ? okJson({ properties: { backup } })
        : errStatus(armStatus);
    },
  );
}

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

describe('backup check service (admin/06)', () => {
  it('reports healthy when retention and restore point pass', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 7,
      earliestRestoreDate: hoursAgo(1),
      geoRedundantBackup: 'Disabled',
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
    expect(result.retentionDays).toBe(7);
    expect(result.reason).toBeNull();
    // IMDS token request carries no credential values in the URL.
    const imdsCall = String(fetchImpl.mock.calls[0]?.[0]);
    expect(imdsCall).not.toMatch(/access_token=|client_secret|password/i);
  });

  it('reports stale when the earliest restore point is too old', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 7,
      earliestRestoreDate: hoursAgo(49),
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.staleHours).toBeCloseTo(49, 1);
    expect(result.reason).toMatch(/49\.0h old/);
    // staleSince = earliestRestore + maxStaleHours (when it crossed the line).
    expect(result.staleSince?.toISOString()).toBe(hoursAgo(1));
  });

  it('reports unhealthy when retention is below the minimum', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 3,
      earliestRestoreDate: hoursAgo(1),
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/retention is 3d/);
  });

  it('reports unhealthy when ARM returns no restore point', async () => {
    const fetchImpl = fakeFetch({ backupRetentionDays: 7 });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/no earliest restore point/);
  });

  it('does not throw when the IMDS token request fails', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        return url.includes('169.254.169.254')
          ? errStatus(500)
          : okJson({ properties: { backup: {} } });
      },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/managed-identity token/);
  });

  it('does not throw when ARM returns an error status', async () => {
    const fetchImpl = fakeFetch({}, 403);
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/status 403/);
  });
});
