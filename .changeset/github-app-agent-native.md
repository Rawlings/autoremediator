---
"@autoremediator/github-app": minor
---

The app understands agents and alerts: `/autoremediator plan|fix|retry|rollback|help` comment commands for people with write access, runs started by Dependabot and code scanning alerts, a bot PR doctor for failing Dependabot and Renovate pull requests (opt in), and the `check_run` subscription that pull request healing needed. Existing registrations must update their events and permissions on GitHub.
