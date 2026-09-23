# Feasly — Database Schema

**Principles:** multi-city and multi-tenant from day one (`city_id`, `tenant_id`
on the relevant tables); estimates are **immutable snapshots** pinned to a
`cost_data_version`; Postgres is the system of record, Google Sheets is a
read-through sync (M4).

```sql
-- Reference
CREATE TABLE cities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,          -- 'calgary'
  name        text NOT NULL,                 -- 'Calgary'
  province    text NOT NULL,                 -- 'AB'
  country     text NOT NULL DEFAULT 'CA',
  timezone    text NOT NULL DEFAULT 'America/Edmonton',
  active      boolean NOT NULL DEFAULT true
);

-- Builders/tenants. NULL tenant = Feasly direct (default lead routing).
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  city_id     uuid REFERENCES cities(id),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Cost data versions: every estimate pins one. Never updated in place —
-- supersede with a new version.
CREATE TABLE cost_data_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version       text NOT NULL,               -- '2026-09-v1'
  city_id       uuid NOT NULL REFERENCES cities(id),
  effective_from timestamptz NOT NULL,
  build_tiers   jsonb NOT NULL,              -- {standard:{per_sqft,low,high},...} server-only
  land          jsonb NOT NULL,              -- per-city land model params, server-only
  reno          jsonb NOT NULL,              -- reno type params, server-only
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, version)
);

-- Cached City assessment lookups (avoid re-hitting Socrata per estimate).
CREATE TABLE properties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id       uuid NOT NULL REFERENCES cities(id),
  address_key   text NOT NULL,               -- normalized address for dedupe
  address_raw   text NOT NULL,
  assessment    jsonb NOT NULL,              -- assessed value, zoning, lot size, polygon...
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, address_key)
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext UNIQUE NOT NULL,
  name        text,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE magic_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text UNIQUE NOT NULL,
  estimate_id uuid,                          -- link lands on this report
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Immutable estimate snapshots. outputs.* are ranges only.
CREATE TABLE estimates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id             uuid NOT NULL REFERENCES cities(id),
  tenant_id           uuid REFERENCES tenants(id),
  user_id             uuid REFERENCES users(id),
  project_type        text NOT NULL CHECK (project_type IN ('new_build','renovation','comparison')),
  inputs              jsonb NOT NULL,       -- address/sqft/tier/reno scope/hoods...
  outputs             jsonb NOT NULL,       -- {land:{low,high}, build:{low,high}, total:{low,high}, rows:[...]}
  cost_data_version_id uuid NOT NULL REFERENCES cost_data_versions(id),
  narrative           jsonb,                 -- AI summary + risks, generated post-gate
  created_at          timestamptz NOT NULL DEFAULT now()
  -- no UPDATEs in app code; corrections = new row
);

-- Leads. lead_score derived from timeline at insert: hot/warm/cold.
CREATE TABLE leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  estimate_id   uuid NOT NULL REFERENCES estimates(id),
  name          text NOT NULL,
  email         citext NOT NULL,
  phone         text NOT NULL,
  timeline      text NOT NULL CHECK (timeline IN ('0-3mo','3-6mo','6-12mo','12+mo','exploring')),
  lead_score    text NOT NULL CHECK (lead_score IN ('hot','warm','cold')),
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','contacted','quoting','won','lost')),
  -- Amendment 2026-09-23: unified with the builder pipeline enum from
  -- epics 05/06 (was new/contacted/qualified/closed/lost). 'quoting' covers
  -- active deal pursuit; 'won'/'lost' are terminal and drive commission
  -- attribution. One enum for consumer leads and builder pipeline.
  notes         text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'web',  -- web | api | mcp
  consent_ts    timestamptz NOT NULL,          -- PIPEDA/CASL consent timestamp
  sheets_synced_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_score_idx ON leads (lead_score, created_at DESC);
CREATE INDEX leads_status_idx ON leads (status);

-- Agent API (M5)
CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id),
  name        text NOT NULL,
  key_hash    text UNIQUE NOT NULL,          -- only the hash is stored
  scopes      text[] NOT NULL DEFAULT '{estimate,lead}',
  rate_limit  int NOT NULL DEFAULT 100,      -- requests / minute
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  uuid NOT NULL REFERENCES api_keys(id),
  endpoint    text NOT NULL,
  estimate_id uuid REFERENCES estimates(id),
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_usage_key_ts ON api_usage (api_key_id, ts DESC);
```

## Notes

- `build_tiers` / `land` / `reno` params are **server-only** — never sent to the
  client. The API returns `outputs` ranges only.
- `estimates.inputs` records exactly what the user entered, so any snapshot can
  be recomputed and audited against its `cost_data_version`.
- Lead dedupe rule (M4): same email + same `address_key` within 90 days updates
  the existing lead instead of creating a duplicate (exact behavior TBD with Karan).
- Sheets sync (M4): `sheets_synced_at` watermark; Postgres remains the source of truth.
