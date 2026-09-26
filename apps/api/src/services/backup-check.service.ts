/**
 * Postgres backup freshness check (admin/06 — `backup_missed` alert class).
 *
 * Reads the flexible server's backup config through the Azure Resource
 * Manager API using the Function App's system-assigned managed identity
 * (IMDS token endpoint — no secrets, no az CLI). Applies the same
 * thresholds as CI's `infra/health/check-postgres-backup.sh`:
 * retention >= minRetentionDays and earliest restore point < maxStaleHours
 * old. A stale/missing backup chain is the "scheduled backup missed"
 * signal that HRD-04's runbook documents.
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the network directly). Logs aggregates only —
 * retention days and stale hours, never credentials or tokens.
 */

export interface BackupFreshness {
  /** True when retention and restore-point freshness both pass. */
  readonly healthy: boolean;
  /** Server the check ran against (for logs). */
  readonly server: string;
  /** Configured backup retention in days (null when ARM didn't return it). */
  readonly retentionDays: number | null;
  /** Earliest available restore point (null when ARM didn't return it). */
  readonly earliestRestore: Date | null;
  /** Age of the earliest restore point in hours (null when unknown). */
  readonly staleHours: number | null;
  /** When the chain is stale: earliestRestore + maxStaleHours (the moment it crossed the threshold). */
  readonly staleSince: Date | null;
  /** Human-readable reason when unhealthy (for logs/alerts — no PII). */
  readonly reason: string | null;
}

export interface BackupCheckServiceDeps {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly serverName: string;
  readonly minRetentionDays: number;
  readonly maxStaleHours: number;
  /** IMDS token endpoint URL (from config — services never hardcode URLs). */
  readonly imdsTokenUrl: string;
  /** ARM base URL (from config — services never hardcode URLs). */
  readonly armBaseUrl: string;
  readonly clock?: () => Date;
  /**
   * Injectable fetch for tests. Defaults to global fetch. Must support the
   * IMDS token endpoint and the ARM GET.
   */
  readonly fetchImpl?: typeof fetch;
}

export interface BackupCheckService {
  checkBackupFreshness(): Promise<BackupFreshness>;
}

const ARM_API_VERSION = '2023-12-01-preview';

interface ArmBackupProperties {
  readonly backupRetentionDays?: number;
  readonly earliestRestoreDate?: string;
  readonly geoRedundantBackup?: string;
}

async function getArmToken(
  fetchImpl: typeof fetch,
  imdsTokenUrl: string,
): Promise<string> {
  const res = await fetchImpl(imdsTokenUrl, {
    headers: { Metadata: 'true' },
  });
  if (!res.ok) {
    throw new Error(`IMDS token request failed (status ${res.status})`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('IMDS token response missing access_token');
  }
  return body.access_token;
}

export function createBackupCheckService(
  deps: BackupCheckServiceDeps,
): BackupCheckService {
  const {
    subscriptionId,
    resourceGroup,
    serverName,
    minRetentionDays,
    maxStaleHours,
    imdsTokenUrl,
    armBaseUrl,
    clock = () => new Date(),
    fetchImpl = fetch,
  } = deps;

  return {
    async checkBackupFreshness(): Promise<BackupFreshness> {
      const now = clock();
      const fail = (
        reason: string,
        partial: Partial<BackupFreshness> = {},
      ): BackupFreshness => ({
        healthy: false,
        server: serverName,
        retentionDays: null,
        earliestRestore: null,
        staleHours: null,
        staleSince: null,
        reason,
        ...partial,
      });

      let token: string;
      try {
        token = await getArmToken(fetchImpl, imdsTokenUrl);
      } catch (error) {
        return fail(
          `could not acquire managed-identity token: ${(error as Error).message}`,
        );
      }

      const url =
        `${armBaseUrl}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${serverName}` +
        `?api-version=${ARM_API_VERSION}`;
      let backup: ArmBackupProperties;
      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return fail(`ARM server query failed (status ${res.status})`);
        }
        const body = (await res.json()) as {
          properties?: { backup?: ArmBackupProperties };
        };
        backup = body.properties?.backup ?? {};
      } catch (error) {
        return fail(`ARM server query failed: ${(error as Error).message}`);
      }

      const retentionDays = backup.backupRetentionDays ?? null;
      const earliestRestore = backup.earliestRestoreDate
        ? new Date(backup.earliestRestoreDate)
        : null;
      const staleHours =
        earliestRestore !== null
          ? (now.getTime() - earliestRestore.getTime()) / 3_600_000
          : null;

      if (retentionDays !== null && retentionDays < minRetentionDays) {
        return fail(
          `backup retention is ${retentionDays}d (minimum ${minRetentionDays}d)`,
          { retentionDays, earliestRestore, staleHours },
        );
      }
      if (staleHours !== null && staleHours > maxStaleHours) {
        const staleSince = new Date(
          (earliestRestore as Date).getTime() + maxStaleHours * 3_600_000,
        );
        return fail(
          `earliest restore point is ${staleHours.toFixed(1)}h old ` +
            `(threshold ${maxStaleHours}h) — backup chain may be stale`,
          { retentionDays, earliestRestore, staleHours, staleSince },
        );
      }
      if (earliestRestore === null) {
        return fail('ARM returned no earliest restore point', {
          retentionDays,
          earliestRestore,
          staleHours,
        });
      }
      return {
        healthy: true,
        server: serverName,
        retentionDays,
        earliestRestore,
        staleHours,
        staleSince: null,
        reason: null,
      };
    },
  };
}
