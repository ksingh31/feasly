/**
 * Backup freshness check tests (admin/06 `backup_missed`).
 *
 * The ARM + managed-identity HTTP calls are faked via an injected fetchImpl —
 * no network, no Azure. Covers: healthy chain (young + mature server),
 * stale newest backup, stale restore point (retention + grace), backup-list
 * fallback, low retention, missing restore point, token failure (platform endpoint +
 * IMDS), ARM error status. None of the tests assert on secrets: the token
 * and the identity header are opaque to the service.
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
  identityEndpoint: undefined as string | undefined,
  identityHeader: undefined as string | undefined,
  armBaseUrl: 'https://management.azure.com',
  clock: () => NOW,
};

/** Deps with the platform (App Service / Functions) identity endpoint. */
const PLATFORM_DEPS = {
  ...DEPS,
  identityEndpoint: 'http://127.0.0.1:41570/MSI/token/',
  identityHeader: 'platform-secret-header',
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function errStatus(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response;
}

/**
 * Backup list fake: completed-backup ages in hours (one page), a list of
 * pages (follows nextLink), or an HTTP error status for the list call.
 */
type BackupList =
  | { readonly agesHours: readonly number[] }
  | { readonly pages: ReadonlyArray<readonly number[]> }
  | { readonly status: number };

function backupItems(agesHours: readonly number[]) {
  return agesHours.map((h, i) => ({
    name: `backup_${i}`,
    properties: { backupType: 'FULL', completedTime: hoursAgo(h), source: 'Automatic' },
  }));
}

const LIST_BASE =
  'https://management.azure.com/subscriptions/sub-123/resourceGroups/rg-feasly-dev' +
  '/providers/Microsoft.DBforPostgreSQL/flexibleServers/feasly-dev-pg-4fhkep/backups';

function backupListResponse(url: string, list: BackupList): Response {
  if ('status' in list) return errStatus(list.status);
  if ('agesHours' in list) return okJson({ value: backupItems(list.agesHours) });
  const pageParam = /[?&]page=(\d+)/.exec(url);
  const page = pageParam ? Number(pageParam[1]) : 0;
  const next = page + 1 < list.pages.length ? `${LIST_BASE}?page=${page + 1}` : undefined;
  return okJson({ value: backupItems(list.pages[page] ?? []), nextLink: next });
}

/**
 * Fake fetch: IMDS returns a token, the ARM server GET returns the given
 * backup block, and the ARM backup list returns `list` (default: a healthy
 * daily chain, newest completed 1h ago).
 */
function fakeFetch(
  backup: unknown,
  armStatus = 200,
  list: BackupList = { agesHours: [49, 25, 1] },
) {
  return vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('169.254.169.254')) {
        return okJson({ access_token: 'fake-token' });
      }
      expect(url).toContain('/flexibleServers/feasly-dev-pg-4fhkep');
      if (url.includes('/backups')) {
        return backupListResponse(url, list);
      }
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
    expect(result.probeError).toBe(false);
    expect(result.retentionDays).toBe(7);
    expect(result.reason).toBeNull();
    // IMDS token request carries no credential values in the URL.
    const imdsCall = String(fetchImpl.mock.calls[0]?.[0]);
    expect(imdsCall).not.toMatch(/access_token=|client_secret|password/i);
  });

  it('prefers the platform identity endpoint over IMDS when configured', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1:41570/MSI/token/')) {
          expect(url).toContain('resource=https%3A%2F%2Fmanagement.azure.com%2F');
          expect(url).toContain('api-version=2019-08-01');
          // The header is sent as a request header, never in the URL.
          expect(
            (init?.headers as Record<string, string>)['X-IDENTITY-HEADER'],
          ).toBe('platform-secret-header');
          return okJson({ access_token: 'platform-token' });
        }
        return okJson({
          properties: {
            backup: {
              backupRetentionDays: 7,
              earliestRestoreDate: hoursAgo(1),
            },
          },
        });
      },
    );
    const svc = createBackupCheckService({ ...PLATFORM_DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
    expect(result.probeError).toBe(false);
    // IMDS was never touched — the platform endpoint served the token.
    expect(
      fetchImpl.mock.calls.some((c) => String(c[0]).includes('169.254.169.254')),
    ).toBe(false);
  });

  it('reports a probe error (not a backup failure) when the platform token request fails', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        return url.startsWith('http://127.0.0.1:41570/MSI/token/')
          ? errStatus(500)
          : okJson({ properties: { backup: {} } });
      },
    );
    const svc = createBackupCheckService({ ...PLATFORM_DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.probeError).toBe(true);
    expect(result.reason).toMatch(/managed-identity token/);
    expect(result.reason).toMatch(/platform identity endpoint/);
    // The secret header never leaks into the reason.
    expect(result.reason).not.toContain('platform-secret-header');
  });

  // #991: the earliest restore point is the OLDEST point in the PITR
  // window — it ages to the retention window and stays there on a healthy
  // server. Its age alone must not page.
  it('reports a young server (earliest restore 72h old, retention 7d) as healthy', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 7,
      earliestRestoreDate: hoursAgo(72),
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
    expect(result.probeError).toBe(false);
    expect(result.staleHours).toBeCloseTo(72, 1);
    expect(result.newestBackupHours).toBeCloseTo(1, 1);
    expect(result.newestBackup?.toISOString()).toBe(hoursAgo(1));
    expect(result.newestBackupError).toBeNull();
    expect(result.reason).toBeNull();
  });

  it('reports a mature server (earliest restore 168h old, retention 7d) as healthy', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 7,
      earliestRestoreDate: hoursAgo(168),
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
    expect(result.staleHours).toBeCloseTo(168, 1);
    expect(result.reason).toBeNull();
  });

  it('queries the backup list endpoint with the bearer token', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 7,
      earliestRestoreDate: hoursAgo(168),
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    await svc.checkBackupFreshness();
    const listCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/backups'));
    expect(String(listCall?.[0])).toBe(`${LIST_BASE}?api-version=2023-12-01-preview`);
    expect(
      (listCall?.[1]?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer fake-token');
  });

  it('reports stale when the newest completed backup is older than the threshold', async () => {
    const fetchImpl = fakeFetch(
      { backupRetentionDays: 7, earliestRestoreDate: hoursAgo(168) },
      200,
      { agesHours: [120, 96, 72, 50] },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.probeError).toBe(false);
    expect(result.newestBackupHours).toBeCloseTo(50, 1);
    expect(result.reason).toMatch(/newest completed backup is 50\.0h old \(threshold 48h\)/);
    // staleSince = newest backup + maxStaleHours (when it crossed the line).
    expect(result.staleSince?.toISOString()).toBe(hoursAgo(2));
  });

  it('uses the newest backup across nextLink pages, whatever the order', async () => {
    const fetchImpl = fakeFetch(
      { backupRetentionDays: 7, earliestRestoreDate: hoursAgo(168) },
      200,
      { pages: [[100, 3], [150, 60]] },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
    expect(result.newestBackupHours).toBeCloseTo(3, 1);
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/backups')),
    ).toHaveLength(2);
  });

  it('reports stale when no backups have completed past the grace period', async () => {
    const fetchImpl = fakeFetch(
      { backupRetentionDays: 7, earliestRestoreDate: hoursAgo(60) },
      200,
      { agesHours: [] },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.newestBackup).toBeNull();
    expect(result.reason).toMatch(/no completed backups listed/);
    expect(result.staleSince?.toISOString()).toBe(hoursAgo(12));
  });

  it('gives a brand-new server with no completed backups the grace period', async () => {
    const fetchImpl = fakeFetch(
      { backupRetentionDays: 7, earliestRestoreDate: hoursAgo(5) },
      200,
      { agesHours: [] },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
  });

  it('reports stale when the earliest restore point is older than retention + grace', async () => {
    // Backup list unavailable → only the CI rule applies: 7d*24 + 48h = 216h.
    const fetchImpl = fakeFetch(
      { backupRetentionDays: 7, earliestRestoreDate: hoursAgo(217) },
      200,
      { status: 403 },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.probeError).toBe(false);
    expect(result.staleHours).toBeCloseTo(217, 1);
    expect(result.reason).toMatch(
      /earliest restore point is 217\.0h old \(threshold 216h = 7d retention \+ 48h grace\)/,
    );
    // staleSince = earliestRestore + 216h.
    expect(result.staleSince?.toISOString()).toBe(hoursAgo(1));
  });

  it('falls back to the earliest-restore rule (not a probe error) when the backup list fails', async () => {
    const fetchImpl = fakeFetch(
      { backupRetentionDays: 7, earliestRestoreDate: hoursAgo(168) },
      200,
      { status: 403 },
    );
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(true);
    expect(result.probeError).toBe(false);
    expect(result.newestBackup).toBeNull();
    expect(result.newestBackupError).toMatch(/backup list query failed \(status 403\)/);
    expect(result.newestBackupError).not.toMatch(/fake-token|bearer/i);
  });

  it('reports unhealthy when retention is below the minimum', async () => {
    const fetchImpl = fakeFetch({
      backupRetentionDays: 3,
      earliestRestoreDate: hoursAgo(1),
    });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.probeError).toBe(false);
    expect(result.reason).toMatch(/retention is 3d/);
  });

  it('reports unhealthy when ARM returns no restore point', async () => {
    const fetchImpl = fakeFetch({ backupRetentionDays: 7 });
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.probeError).toBe(false);
    expect(result.reason).toMatch(/no earliest restore point/);
  });

  it('reports a probe error (not a backup failure) when the IMDS token request fails', async () => {
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
    expect(result.probeError).toBe(true);
    expect(result.reason).toMatch(/managed-identity token/);
  });

  it('reports a probe error (not a backup failure) when ARM returns an error status', async () => {
    const fetchImpl = fakeFetch({}, 403);
    const svc = createBackupCheckService({ ...DEPS, fetchImpl });
    const result = await svc.checkBackupFreshness();
    expect(result.healthy).toBe(false);
    expect(result.probeError).toBe(true);
    expect(result.reason).toMatch(/status 403/);
  });
});
