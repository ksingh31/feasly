# Azure infrastructure (Bicep) — FND-003 / FND-004

- Subscription: "Azure subscription 1" (`9b7d7805-311a-4e4f-ac48-5d281d7e1185`)
- Tenant: Default Directory (`e9b8f029-1138-4a0f-86c4-88c4a84d0d68`)
- Billing rule (standing, 2026-09-23): **stay on the free tier — never
  change/upgrade the subscription type** without Karan's explicit approval.
- Bicep modules for all ADR resources are authored (not applied) in FND-004:
  resource group, Static Web App, Function App (Flex Consumption),
  Postgres Flexible Server, Key Vault, App Insights, DNS zone, Blob Storage.
- Every `az deployment` here runs as `what-if` until Karan approves apply.
