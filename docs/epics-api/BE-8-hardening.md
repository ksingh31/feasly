# BE-8 — Hardening

### BE8-001 — Observability
**Size:** S — Application Insights wired via the Functions host; structured logs
with correlation IDs; alerts on 5xx rate and queue poison depth.
**Tests:** a 500 in staging surfaces in logs with its correlation ID.

### BE8-002 — Security pass
**Size:** M — Security headers (via SWA config + Function responses), CORS
allowlist from config, secrets only from Key Vault / env (CI grep for
connection strings, keys, tokens in source), dependency audit in CI
(`npm audit` / Dependabot). Rate-limit review against BE4-003.
**Acceptance criteria:** no secret-shaped literals in the repo (gitleaks-style
scan green); OWASP ASVS L1 self-review recorded in the PR.

### BE8-003 — Load test
**Size:** S — k6 (or Azure Load Testing) script: 10x expected launch traffic
against staging; p95 on estimate + lead submit within budget (budget set from
config, recorded in the story). **Dependencies:** BE-3, BE-5.
