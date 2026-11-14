---
"autoremediator": minor
---

Plan, apply, resume and roll back: runs persisted on disk.

- `planRemediation` now records the preview as a run under `.autoremediator/runs/<runId>/` and
  returns `runId` and `planId` on the report (none with `evidence: false`). The plan lists the
  version bumps and overrides it will make with their exact target versions, and what it cannot act
  on and why. The plan id is a content hash.
- New `applyPlan`, `resumeRun`, `rollbackRun`, `getRun` and `listRuns` on the SDK, MCP
  (`applyPlan`, ...), HTTP (`/runs/apply`, `/runs/resume`, `/runs/rollback`, `/runs/get`,
  `/runs/list`) and the CLI (`plan <cve>`, `runs list|show|apply|resume|rollback`).
- A plan is refused when the manifests, lockfiles or policy changed since it was made. Before the
  first change the manifests, lockfiles, patch files and tsconfigs are snapshotted to disk; every
  item is recorded in a hash-chained ledger; a crash can be resumed, and only from a project that
  still matches the last completed step. One apply runs per run at a time.
- Rollback restores the snapshot (also from a fresh process), reinstalls dependencies from the
  restored lockfile so `node_modules` matches, and refuses if the project changed since the run
  unless forced.
- Version selection can now move past fixed versions that have advisories of their own (a patch
  candidate with known advisories is skipped for the next clean one), and says which it skipped.
