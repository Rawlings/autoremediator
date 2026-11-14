---
"@autoremediator/github-app": minor
---

Comment commands and alert triggers, and the missing `check_run` subscription.

- The app manifest now subscribes to `check_run` (pull request healing could never fire without it),
  `issue_comment`, `dependabot_alert` and `code_scanning_alert`, and asks for `issues: write`,
  `vulnerability_alerts: read` and `security_events: read`. Existing registrations need their
  permissions and events updated.
- `/autoremediator plan|fix|help <CVE or GHSA ids>` on issues and pull requests. Write or admin access
  is required; `plan` never changes anything, `fix` opens a pull request for review. Bot comments,
  quoted text and code blocks are ignored, and only strictly matching advisory ids are used.
- A Dependabot alert (or a code scanning alert whose rule is a CVE or GHSA) starts a run for that
  advisory under the repository's own settings.
