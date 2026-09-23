# Branch protection — `main` (FND-002)

Intended settings (to apply once CI is green on main):

- Require a pull request before merging (min 1 approval)
- Require status checks to pass: `build` (the CI workflow job)
- Do not allow bypassing the above settings
- No direct pushes to `main`

Apply with:

```bash
gh api repos/ksingh31/feasly/branches/main/protection -X PUT \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=build \
  -f enforce_admins=true \
  -f restrictions=null
```

Note: while Muse is the primary builder, PR-required means every change
needs Karan's approval tap. Decide: protection now, or after M0 sprint.
