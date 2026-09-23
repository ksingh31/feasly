# Branch protection — `main` (FND-002)

**Status: APPLIED 2026-09-23** via the API command below.

Settings:

- Require a pull request before merging (min 1 approval)
- Require status checks to pass: `build` (the CI workflow job), strict
- Enforce on admins (no bypassing)
- No direct pushes to `main`

Applied with:

```bash
gh api repos/ksingh31/feasly/branches/main/protection -X PUT \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=build \
  -f enforce_admins=true \
  -f restrictions=null
```

Working agreement: Muse builds on feature branches, opens PRs, Karan
reviews/approves from his phone, PR merges on green CI.
