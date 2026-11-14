---
"autoremediator": minor
---

A deterministic verifier judges every change made through a plan.

- New `verifyRun` (SDK, MCP, `POST /runs/verify`, `autoremediator runs verify <id>`) runs independent
  checks against a run's project, cheapest first, stopping at the first failure: `scope` (only
  dependency files changed; never CI workflows, the policy file, `.git`; project source only when
  allowed), `policy` (allow/deny lists, major bumps, strategy constraints), `supply-chain` (including
  your package manager's cooldown), `install` (a frozen install succeeds), `vuln-gone` (no installed
  package still matches the advisory), and `typecheck`, `tests` and `proof-of-fix` when requested.
  The result is stored in the run.
- `applyPlan` verifies each item after applying it (`scope`, `policy`, `supply-chain`, `vuln-gone`)
  and takes it back out, restoring the project and reinstalling, if a check fails, whatever the apply
  step reported. `--no-verify` / `verify: false` disables it. Rejected items are recorded in the
  ledger with the failing check's details.
- The version-bump tool shares one command runner with the verifier.
