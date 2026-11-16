/**
 * Postgres backup freshness check (admin/06 — `backup_missed` alert class).
 *
 * Reads the flexible server's backup config through the Azure Resource
 * Manager API using the Function App's system-assigned managed identity
 * (no secrets, no az CLI). Two freshness rules (#991):
 *
 * 1. Newest completed backup — lists `.../flexibleServers/{name}/backups`
 *    and flags the chain stale when the newest `completedTime` is older
 *    than `maxStaleHours` (48h default). This catches a stopped chain
 *    within ~2 days. If the backup list call fails, the check falls back
 *    to rule 2 alone (`newestBackupError` says why) — the server query
 *    already succeeded, so this is not a probe failure.
 * 2. Earliest restore point — the same rule as CI's
 *    `infra/health/check-postgres-backup.sh`: retention >= minRetentionDays
 *    and the earliest restore point is no older than
 *    `retentionDays*24 + maxStaleHours` (retention window + grace). The
 *    earliest restore point is the OLDEST point in the PITR window: on a
 *    healthy server it ages until it reaches the retention window and then
 *    stays there, so its age alone is not a staleness signal — only an age
 *    beyond the whole window is.
 *
 * A stale/missing backup chain is the "scheduled backup missed" signal that
 * HRD-04's runbook documents.
 *
 * Token acquisition order: the platform-injected `IDENTITY_ENDPOINT` /
 * `IDENTITY_HEADER` env vars (the documented managed-identity token path
 * on Azure Functions / App Service — the IMDS link-local IP is the VM
 * path and is not reachable from the Functions sandbox), falling back to
 * the IMDS URL for non-Functions hosts.
 *
 * Probe failures (token acquisition, ARM query) are reported with
 * `probeError: true` — they mean the check itself could not run, NOT that
 * the backup chain is unhealthy. The timer logs and skips on probe
 * errors (structured `PROBE FAILED` line for Azure Monitor) and never
 * fires the `backup_missed` alert for them; CI's backup-config job is the
 * backstop for a broken probe.
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the network directly). Logs aggregates only —
 * retention days and stale hours, never credentials or tokens.
 */

export interface BackupFreshness {
  /** True when retention and restore-point freshness both pass. */
  readonly healthy: boolean;
  /**
   * True when the check itself could not run (managed-identity token or
   * ARM query failed). Not a backup-health signal — the backup chain may
   * be fine; the probe just couldn't verify it.
   */
  readonly probeError: boolean;
  /** Server the check ran against (for logs). */
  readonly server: string;
  /** Configured backup retention in days (null when ARM didn't return it). */
  readonly retentionDays: number | null;
  /** Earliest available restore point (null when ARM didn't return it). */
  readonly earliestRestore: Date | null;
  /** Age of the earliest restore point in hours (null when unknown). */
  readonly staleHours: number | null;
  /** Newest completed backup (null when unknown or the list call failed). */
  readonly newestBackup: Date | null;
  /** Age of the newest completed backup in hours (null when unknown). */
  readonly newestBackupHours: number | null;
  /**
   * Why the newest-backup rule could not run (backup list call failed);
   * null when it ran. The check then relied on the earliest-restore rule.
   */
  readonly newestBackupError: string | null;
  /** When the chain is stale: the moment it crossed the threshold that failed. */
  readonly staleSince: Date | null;
  /** Human-readable reason when unhealthy (for logs/alerts — no PII). */
  readonly reason: string | null;
}

export interface BackupCheckServiceDeps {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly serverName: string;
  readonly minRetentionDays: number;
  /**
   * Grace in hours: the newest completed backup may be at most this old,
   * and the earliest restore point at most `retentionDays*24 + maxStaleHours`.
   */
  readonly maxStaleHours: number;
  /** IMDS token endpoint URL (from config — services never hardcode URLs). */
  readonly imdsTokenUrl: string;
  /**
   * Platform-injected managed-identity endpoint (App Service / Functions
   * `IDENTITY_ENDPOINT`). Preferred over IMDS when present.
   */
  readonly identityEndpoint?: string;
  /**
   * Platform-injected managed-identity header (`IDENTITY_HEADER`). Secret —
   * sent as the `X-IDENTITY-HEADER` header, never logged or interpolated
   * into error messages.
   */
  readonly identityHeader?: string;
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
/** Token API version for the platform identity endpoint (2019-08-01). */
const IDENTITY_ENDPOINT_API_VERSION = '2019-08-01';

/** Safety cap on `nextLink` pages followed in the backup list. */
const MAX_BACKUP_LIST_PAGES = 10;
const MS_PER_HOUR = 3_600_000;

interface ArmBackupListPage {
  readonly value?: ReadonlyArray<{ properties?: { completedTime?: string } }>;
  readonly nextLink?: string;
}

/**
 * Newest `completedTime` across the server's completed backups (follows
 * `nextLink`, capped). Returns null when the server has no completed
 * backups. Throws on an HTTP error so the caller can fall back.
 */
async function getNewestBackup(
  fetchImpl: typeof fetch,
  firstUrl: string,
  token: string,
): Promise<Date | null> {
  let newest: number | null = null;
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < MAX_BACKUP_LIST_PAGES; page++) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`ARM backup list query failed (status ${res.status})`);
    }
    const body = (await res.json()) as ArmBackupListPage;
    for (const item of body.value ?? []) {
      const completed = item.properties?.completedTime;
      if (!completed) continue;
      const t = new Date(completed).getTime();
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
    url = body.nextLink;
  }
  return newest === null ? null : new Date(newest);
}

interface ArmBackupProperties {
  readonly backupRetentionDays?: number;
  readonly earliestRestoreDate?: string;
  readonly geoRedundantBackup?: string;
}

/**
 * Acquire an ARM token for the Function App's managed identity.
 *
 * Prefers the platform-injected identity endpoint (the documented token
 * path on Azure Functions / App Service); falls back to the IMDS
 * link-local endpoint for VM-style hosts. The identity header is a
 * secret: it is only ever sent as a request header, never logged. The
 * token audience is derived from the configured ARM base URL (config
 * owns the URL literal — services never hardcode one).
 */
async function getArmToken(
  fetchImpl: typeof fetch,
  imdsTokenUrl: string,
  armBaseUrl: string,
  identityEndpoint?: string,
  identityHeader?: string,
): Promise<string> {
  if (identityEndpoint && identityHeader) {
    const resource = armBaseUrl.endsWith('/') ? armBaseUrl : `${armBaseUrl}/`;
    const url =
      `${identityEndpoint}?resource=${encodeURIComponent(resource)}` +
      `&api-version=${IDENTITY_ENDPOINT_API_VERSION}`;
    const res = await fetchImpl(url, {
      headers: { 'X-IDENTITY-HEADER': identityHeader },
    });
    if (!res.ok) {
      throw new Error(
        `platform identity endpoint token request failed (status ${res.status})`,
      );
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error(
        'platform identity endpoint token response missing access_token',
      );
    }
    return body.access_token;
  }
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
    identityEndpoint,
    identityHeader,
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
        probeError = false,
      ): BackupFreshness => ({
        healthy: false,
        probeError,
        server: serverName,
        retentionDays: null,
        earliestRestore: null,
        staleHours: null,
        newestBackup: null,
        newestBackupHours: null,
        newestBackupError: null,
        staleSince: null,
        reason,
        ...partial,
      });

      let token: string;
      try {
        token = await getArmToken(
          fetchImpl,
          imdsTokenUrl,
          armBaseUrl,
          identityEndpoint,
          identityHeader,
        );
      } catch (error) {
        // Probe failure, not a backup-health signal: the check itself
        // could not run. Reported with probeError so the timer skips the
        // alert instead of paging as a backup failure.
        return fail(
          `could not acquire managed-identity token: ${(error as Error).message}`,
          {},
          true,
        );
      }

      const serverUrl =
        `${armBaseUrl}/subscriptions/${subscriptionId}` +
        `/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${serverName}`;
      const url = `${serverUrl}?api-version=${ARM_API_VERSION}`;
      let backup: ArmBackupProperties;
      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return fail(`ARM server query failed (status ${res.status})`, {}, true);
        }
        const body = (await res.json()) as {
          properties?: { backup?: ArmBackupProperties };
        };
        backup = body.properties?.backup ?? {};
      } catch (error) {
        return fail(`ARM server query failed: ${(error as Error).message}`, {}, true);
      }

      const retentionDays = backup.backupRetentionDays ?? null;
      const earliestRestore = backup.earliestRestoreDate
        ? new Date(backup.earliestRestoreDate)
        : null;
      const staleHours =
        earliestRestore !== null
          ? (now.getTime() - earliestRestore.getTime()) / MS_PER_HOUR
          : null;

      // Rule 1 input: newest completed backup. A failed list call is not a
      // probe failure (the server query worked) — fall back to rule 2.
      let newestBackup: Date | null = null;
      let newestBackupError: string | null = null;
      let newestBackupListed = false;
      try {
        newestBackup = await getNewestBackup(
          fetchImpl,
          `${serverUrl}/backups?api-version=${ARM_API_VERSION}`,
          token,
        );
        newestBackupListed = true;
      } catch (error) {
        newestBackupError = (error as Error).message;
      }
      const newestBackupHours =
        newestBackup !== null
          ? (now.getTime() - newestBackup.getTime()) / MS_PER_HOUR
          : null;
      const facts = {
        retentionDays,
        earliestRestore,
        staleHours,
        newestBackup,
        newestBackupHours,
        newestBackupError,
      };

      if (retentionDays !== null && retentionDays < minRetentionDays) {
        return fail(
          `backup retention is ${retentionDays}d (minimum ${minRetentionDays}d)`,
          facts,
        );
      }
      if (newestBackupHours !== null && newestBackupHours > maxStaleHours) {
        return fail(
          `newest completed backup is ${newestBackupHours.toFixed(1)}h old ` +
            `(threshold ${maxStaleHours}h) — backup chain may be stale`,
          {
            ...facts,
            staleSince: new Date(
              (newestBackup as Date).getTime() + maxStaleHours * MS_PER_HOUR,
            ),
          },
        );
      }
      if (
        newestBackupListed &&
        newestBackup === null &&
        staleHours !== null &&
        staleHours > maxStaleHours
      ) {
        // The server is past the grace period and has never completed a
        // backup. (A brand-new server gets the grace before this fires.)
        return fail(
          `no completed backups listed and the server's earliest restore ` +
            `point is ${staleHours.toFixed(1)}h old (threshold ${maxStaleHours}h)`,
          {
            ...facts,
            staleSince: new Date(
              (earliestRestore as Date).getTime() + maxStaleHours * MS_PER_HOUR,
            ),
          },
        );
      }
      // Rule 2 (same as CI): stale only when the earliest restore point is
      // older than the whole retention window + grace.
      const maxEarliestAgeHours =
        retentionDays !== null
          ? retentionDays * 24 + maxStaleHours
          : maxStaleHours;
      if (staleHours !== null && staleHours > maxEarliestAgeHours) {
        const staleSince = new Date(
          (earliestRestore as Date).getTime() + maxEarliestAgeHours * MS_PER_HOUR,
        );
        return fail(
          `earliest restore point is ${staleHours.toFixed(1)}h old ` +
            `(threshold ${maxEarliestAgeHours}h = ` +
            `${retentionDays ?? 0}d retention + ${maxStaleHours}h grace) ` +
            `— backup chain may be stale`,
          { ...facts, staleSince },
        );
      }
      if (earliestRestore === null) {
        return fail('ARM returned no earliest restore point', facts);
      }
      return {
        healthy: true,
        probeError: false,
        server: serverName,
        ...facts,
        staleSince: null,
        reason: null,
      };
    },
  };
}
