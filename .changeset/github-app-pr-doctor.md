---
"@autoremediator/github-app": minor
---

Bot PR doctor, `retry` and `rollback` comment commands, and a repair strategy seam.

- **Bot PR doctor** (off by default; `botPrDoctor: { enabled, maxAttempts }` in
  `.github/autoremediator.yml`). When CI fails on a Dependabot or Renovate pull request in the same
  repository, it diagnoses the failure and either pushes a fast-forward repair commit to the bot's
  branch or leaves one comment with the diagnosis. It never force-pushes, never writes lockfiles,
  `package.json`, workflows or policy files, ignores forks, counts attempts per pull request (once per
  head commit) in the app state store, and treats check output as untrusted text.
- `/autoremediator retry <ids>` repeats the last `plan` or `fix` for those advisories in the
  repository; `/autoremediator rollback` replies with the exact `autoremediator runs rollback <runId>`
  command for the `Autoremediator-Run:` trailers it finds, and changes nothing. There is no `approve`
  command.
- `RepairStrategy` interface (`createDefaultRemediationHandler({ repairStrategy })`), with the
  pattern-based repair as the default. Pull request healing now also refuses to write lockfiles,
  workflows, policy files and paths outside the repository.
- `enablePrAutoHealing` and `maxHealingAttempts` in `.github/autoremediator.yml` were documented but
  silently dropped by the config parser; they are now read.
- `AppStateStore` gained `reserveDoctorAttempt`, `recordRemediationMode` and `getRemediationMode`.
  The state file stays at schema version 1 and older files load unchanged.
