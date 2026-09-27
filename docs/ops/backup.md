# Postgres backup & restore runbook (HRD-04)

> **Scope:** the existing free-tier Postgres (`feasly-dev-pg-4fhkep` in
> `rg-feasly-dev`). No new resources, no tier changes — per the standing rule.
> Lead PII lives here; losing it is the worst failure mode, so this page is
> the single source of truth for "how is it backed up" and "how do we get it back".

## 1. Backup schedule & retention (verified live 2026-09-24)

Azure Database for PostgreSQL — Flexible Server takes **automated backups**
with no operator action:

| Setting | Value |
|---|---|
| Backup retention | **7 days** |
| Geo-redundant backup | Disabled (dev) |
| Earliest restore point (as of 2026-09-24) | 2026-09-23T22:42Z — chain is fresh |

Azure's backup chain for flexible servers: a weekly full backup, differential
backups twice a day, and transaction-log backups **every ~5 minutes**.
Point-in-time restore (PITR) can target any second inside the 7-day retention
window, which is what gives the RPO below.

**Continuous verification:** the daily `backup-check-timer` Function (06:00 UTC)
queries this server's backup config through ARM with the Function App's
managed identity and fires the `backup_missed` ops alert (one email per 24h,
all-clear on recovery) when retention drops below 7 days or the earliest
restore point goes stale (> 48h old). CI's `backup-config` job
(`infra/health/check-postgres-backup.sh`, same thresholds) remains as a
push-time backstop.

Token path: the probe acquires its ARM token from the platform-injected
`IDENTITY_ENDPOINT` / `IDENTITY_HEADER` (the documented managed-identity
path on Azure Functions), falling back to the IMDS link-local endpoint on
VM-style hosts. A probe failure (token or ARM query) is **not** a backup
failure: the timer logs a structured `backup-check-timer: PROBE FAILED`
line and skips the ops email, and the `backup-check-probe` Azure Monitor
rule pages ops on that line. (2026-09-27: the first probe run used the
VM-only IMDS endpoint from the Functions sandbox, failed to get a token,
and false-positived as "Postgres backup is failing" — fixed by the
platform-endpoint switch plus the probe-error distinction.)

## 2. RTO / RPO

| Metric | Target | Proven by drill |
|---|---|---|
| RPO (max data loss) | ≤ 5 min (transaction-log interval) | **pending drill** |
| RTO (restore to serving) | ≤ 1 h (DB is tiny — expect minutes) | **pending drill** |

Targets are set from the platform's documented backup cadence. The drill
(§4) replaces the "pending" cells with measured values; the targets above
are then adjusted to what the drill actually proved.

## 3. What gets restored

The whole server: `estimates` + `leads` tables (lead PII), schema, and all
rows up to the chosen restore point. There is no table-level restore — a
partial loss still means a full-server PITR to a staging server, then copying
the needed rows across.

## 4. PITR drill procedure (staging-only)

**Iron rule: production data is NEVER restored over production.** Every
restore targets a *new* server whose name starts with `feasly-drill-`. The
runnable drill script `tools/pitr-drill.sh` enforces this with a unit-tested
guard (target must start with `feasly-drill-`, must differ from the source,
source must not itself be a drill server) and refuses to run otherwise.
Prefer the script over the manual steps below — it adds restore-point
validation, RTO timing, the RPO cross-check against production, and automatic
teardown:

```bash
bash tools/pitr-drill.sh --source-server feasly-dev-pg-4fhkep \
  --resource-group rg-feasly-dev \
  --restore-point "$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
```

The manual equivalent, step by step:

### 4.1. Pick a restore point

Choose an ISO-8601 timestamp inside the retention window, e.g. 10 minutes
ago:

```bash
RESTORE_POINT="$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
echo "$RESTORE_POINT"
```

### 4.2. Restore to a NEW staging server

```bash
set -euo pipefail
SRC="feasly-dev-pg-4fhkep"
RG="rg-feasly-dev"
DRILL="feasly-drill-$(date -u +%Y%m%d-%H%M)"

# Guard: the drill target must never be the production server.
[[ "$DRILL" != "$SRC" ]] || { echo "REFUSING: drill target == source"; exit 1; }

az postgres flexible-server restore \
  --name "$DRILL" \
  --source-server "$SRC" \
  --resource-group "$RG" \
  --restore-time "$RESTORE_POINT"
echo "drill server: $DRILL"
```

### 4.3. Verify integrity

```bash
# The drill server inherits the source's firewall rules; add a temporary rule
# for the operator IP (it is deleted automatically with the server in §4.4):
MY_IP="$(curl -s --max-time 10 https://api.ipify.org)"
az postgres flexible-server firewall-rule create \
  -n "$DRILL" -g "$RG" \
  --rule-name drill-tmp-operator \
  --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"

DRILL_HOST="$(az postgres flexible-server show -n "$DRILL" -g "$RG" \
  --query fullyQualifiedDomainName -o tsv)"
# Admin login is discovered, not guessed:
ADMIN_USER="$(az postgres flexible-server show -n "$DRILL" -g "$RG" \
  --query administratorLogin -o tsv)"
# Key Vault name carries a hash suffix — discover it; the secret name is fixed
# by infra/bicep/main.bicep (postgresSecretName).
KV_NAME="$(az keyvault list -g "$RG" \
  --query "[?starts_with(name,'feasly-dev-kv')].name | [0]" -o tsv)"
ADMIN_PW="$(az keyvault secret show --vault-name "$KV_NAME" \
  --name feasly-dev-postgres-admin --query value -o tsv)"

export PGPASSWORD="$ADMIN_PW"
# The app database is `feasly` (see infra/bicep/modules/postgres.bicep), not
# the default `postgres` database.
DSN="host=$DRILL_HOST user=$ADMIN_USER dbname=feasly sslmode=require"
# Row counts + latest write must be present and no newer than the restore point.
psql "$DSN" -c \
  "SELECT count(*) AS estimates, max(created_at) AS latest_estimate FROM estimates;"
psql "$DSN" -c \
  "SELECT count(*) AS leads, max(created_at) AS latest_lead FROM leads;"
psql "$DSN" -c \
  "SELECT count(*) AS writes_after_restore_point FROM estimates WHERE created_at > timestamptz '$RESTORE_POINT';"
psql "$DSN" -c \
  "SELECT count(*) AS writes_after_restore_point FROM leads WHERE created_at > timestamptz '$RESTORE_POINT';"
# ^ both must be 0: nothing newer than the restore point may exist.
```

Record: date, operator, restore point, time from `restore` command to first
successful query (= measured RTO), row counts, and the
`writes_after_restore_point = 0` result.

### 4.4. Tear the drill server down

```bash
az postgres flexible-server delete -n "$DRILL" -g "$RG" --yes
```

The drill server must not outlive the drill — it carries a copy of lead PII.

### 4.5. Record the evidence

Append a row to §6 below (date, operator, measured RTO/RPO, pass/fail) and
update the "Proven by drill" cells in §2.

## 5. "Backup missed" alert path

1. CI job `backup-config` fails (retention < 7d or stale chain) → investigate
   immediately: `bash infra/health/check-postgres-backup.sh` locally for detail.
2. Common causes: retention changed in the portal/Bicep, or the backup
   service is degraded (check Azure Service Health for the region).
3. **Forward path:** when `admin/06-admin-ops-alerts` lands, add a
   `postgres_backup_missed` alert class (2 consecutive CI failures → ops
   email). Until then, the red CI job *is* the alert — do not ignore it.

## 6. Drill log

| Date | Operator | Restore point | Measured RTO | RPO verified | Result |
|---|---|---|---|---|---|
| — | — | — | — | — | **Not yet run.** Needs approval to provision the short-lived drill server (torn down same session; burstable tier). `tools/pitr-drill.sh` prints the row to paste here when the drill runs. |

## 7. Policy

- The drill is repeated **after any infrastructure change to the database**
  (SKU, region, retention, firewall/VNet) and at least once before launch.
- This page is updated whenever the backup configuration changes.
- Drill restores are staging-only, always. No exceptions, no "quick"
  production restores — a production incident gets a new server first, then a
  controlled cutover.
