# Plan, apply and roll back

A run records what was planned and what was done, so a fix can be reviewed before it happens, picked
up after a crash, and undone afterwards. It is the flow an agent should use, and it works the same
from the CLI, the SDK, MCP and HTTP.

```bash
autoremediator plan CVE-2021-23337      # preview; prints a run id and a plan id
autoremediator runs show <runId>        # what it will change, and what it cannot
autoremediator runs apply <runId>       # snapshot, apply each change, record each step
autoremediator runs rollback <runId>    # restore what it changed
```

## Plan

`plan` (SDK and MCP: `planRemediation`) previews the fix and stores it under
`.autoremediator/runs/<runId>/`. It changes nothing in your project. The plan lists the changes it
will make, each with the exact target version the preview chose, and the findings it cannot act on,
with the reason: a suppressed advisory, an unresolved one, or a fix that needs a model-generated
patch. A patch is written when it is applied and cannot be previewed exactly, so plans contain
version bumps and overrides only.

A plan has a content id (`plan_` plus 16 hex digits): the same plan always has the same id. It also
records the fingerprint of what it was made against: your manifests, lockfiles, patch files and
policy. Pass `evidence: false` (`--no-evidence`) to record no run at all.

## Apply

`runs apply` (SDK and MCP: `applyPlan`) takes a run id, or a plan id, and applies the plan's items.
Reviewing the plan is the approval step; `--item <id>` applies only some of it.

- **Stale plans are refused.** If your manifests, lockfiles or policy changed since the plan was
  made, nothing is applied and you are told to plan again. The commit itself may differ.
- **A snapshot comes first.** Before the first change, the manifests, lockfiles, patch files and
  tsconfig files are copied into the run directory, so a rollback works from another process, days
  later.
- **Every step is recorded.** Each item is logged as started and as done or failed, with the
  project fingerprint after it. One item failing does not stop the rest; a crash or an error does.
- **One apply at a time.** A run is locked while it is being applied. A lock left by a process that
  has died is taken over.

The run ends `applied` (every item applied), `partial` (some not) or `failed`.

## Resume

`runs resume` (`resumeRun`) continues a run that was interrupted, or ended partial or failed,
skipping items already applied. It first checks that the project is exactly as the last completed
step left it. If an interrupted install left it half-changed, resume refuses, and you either inspect
the project or roll the run back.

## Roll back

`runs rollback` (`rollbackRun`) restores the files the snapshot covers and then reinstalls
dependencies from the restored lockfile (a frozen install), so `node_modules` matches again. Pass
`reinstall: false` to skip that. If the reinstall fails, the files are still restored and the report
says so.

A rollback is refused when the project changed since the run's last step, because restoring would
discard that work; `--force` overrides it. The report says whether the project matches the state the
plan was made against again (`matchesBase`).

## What is stored

`.autoremediator/runs/<runId>/` holds `run.json` (status), `plan.json`, `report.json` (the preview),
`steps.jsonl` (the ledger) and `snapshot/` (the files to restore). Each ledger line carries the hash
of the one before it, so `runs show` can tell you when a line was edited or removed. That detects
accidental or partial tampering; anyone who can write the directory can rewrite the whole file, so
it is not a signature.

Run ids and plan ids are validated everywhere they are used, so they cannot point outside the runs
directory. The directory is in `.gitignore` by default with the rest of `.autoremediator/`.
