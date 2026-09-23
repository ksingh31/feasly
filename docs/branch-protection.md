# Branch protection — `main` (FND-002)

**Status: APPLIED 2026-09-23** (repo is public, so free-account protection works).

Settings:

- Pull request required before merging (direct pushes blocked)
- Required approvals: **0** — deliberate. ksingh31 is the only human on the
  account and GitHub doesn't count self-approvals, so requiring ≥1 approval
  would deadlock every PR forever. CI is the gate; Karan reviews when he wants.
- Required status checks: `build` (CI workflow job), strict (branch must be
  up to date)
- Enforce on admins (no bypassing)

Applied with:

```bash
gh api repos/ksingh31/feasly/branches/main/protection -X PUT \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=build \
  -f enforce_admins=true \
  -f restrictions=null
```

Working agreement: Muse builds on feature branches, opens PRs, CI must be
green, Muse merges (Karan reviews/approves whenever he wants — nothing waits
on him).
