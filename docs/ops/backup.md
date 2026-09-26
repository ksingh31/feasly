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

**Continuous verification:** CI runs `infra/health/check-postgres-backup.sh`
on every push to main (workflow job `backup-config`). It fails if retention
drops below 7 days or the earliest restore point goes stale (> 48h old),
which is the "scheduled backup missed" signal until the ops-alert service
(`admin/06`) wires a dedicated alert class. The script's failure branches are unit-tested with a
mocked `az` in `infra/health/test/test-checks.sh` (§8), so a regression in the
check itself fails the `build` job before it ever runs against Azure.

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
drill script asserts the target name differs from the source before running.

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
# Allow a firewall rule for the operator IP, then:
DRILL_HOST="$(az postgres flexible-server show -n "$DRILL" -g "$RG" \
  --query fullyQualifiedDomainName -o tsv)"
# Key Vault name carries a hash suffix — discover it; the secret name is fixed
# by infra/bicep/main.bicep (postgresSecretName).
KV_NAME="$(az keyvault list -g "$RG" \
  --query "[?starts_with(name,'feasly-dev-kv')].name | [0]" -o tsv)"
ADMIN_PW="$(az keyvault secret show --vault-name "$KV_NAME" \
  --name feasly-dev-postgres-admin --query value -o tsv)"

export PGPASSWORD="$ADMIN_PW"
# Row counts + latest write must be present and no newer than the restore point.
psql "host=$DRILL_HOST user=<admin-user> dbname=postgres sslmode=require" -c \
  "SELECT count(*) AS estimates, max(created_at) AS latest_estimate FROM estimates;"
psql "host=$DRILL_HOST user=<admin-user> dbname=postgres sslmode=require" -c \
  "SELECT count(*) AS leads, max(created_at) AS latest_lead FROM leads;"
psql "host=$DRILL_HOST user=<admin-user> dbname=postgres sslmode=require" -c \
  "SELECT count(*) AS writes_after_restore_point FROM estimates WHERE created_at > timestamptz '$RESTORE_POINT';"
# ^ must be 0: nothing newer than the restore point may exist.
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
| — | — | — | — | — | **Not yet run.** Needs approval to provision the short-lived drill server (torn down same session; burstable tier). |

## 7. Policy

- The drill is repeated **after any infrastructure change to the database**
  (SKU, region, retention, firewall/VNet) and at least once before launch.
- This page is updated whenever the backup configuration changes.
- Drill restores are staging-only, always. No exceptions, no "quick"
  production restores — a production incident gets a new server first, then a
  controlled cutover.
