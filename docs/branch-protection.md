# Branch protection — `main` (FND-002)

**Status: NOT APPLIED — blocked 2026-09-23.** GitHub's branch protection
API returns 403 on free accounts for private repos:
"Upgrade to GitHub Pro or make this repository public to enable this feature."
(Verified with minimal and full payloads.)

Options:
1. **Private + free (current):** no technical branch protection available.
   Enforced by convention instead — Muse always works on feature branches
   and opens PRs; Karan reviews/approves; merge only on green CI.
2. **Private + GitHub Pro (~CA$5.50/user/mo):** full protection (required
   reviews, required `build` check, no bypass, no direct pushes).
3. **Public + free:** full protection available, but code is public.

Intended full-protection command (for option 2 or 3):

```bash
gh api repos/ksingh31/feasly/branches/main/protection -X PUT \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=build \
  -f enforce_admins=true \
  -f restrictions=null
```

Working agreement (option 1, in effect): Muse builds on feature branches,
opens PRs, Karan reviews/approves from his phone, PR merges on green CI.
