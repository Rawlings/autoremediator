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

- **Each item is verified.** After an item applies, the [verifier](#verify) checks that only
  dependency files changed, the policy and supply-chain rules hold, and no installed package still
  matches the advisory. If any check fails, the item is taken back out (the project is restored from
  a copy taken just before it and dependencies are reinstalled), the reason is recorded, and the
  next item goes ahead. `--no-verify` (`verify: false`) turns this off.

The run ends `applied` (every item applied), `partial` (some not, including ones that were rejected)
or `failed`.

## Repair with an agent

An upgrade that fixes the advisory can still break your project: a removed argument, a renamed
export. When an item fails the project's own checks (`--run-tests`, `--typecheck`) and a model is
configured, `runs apply` hands it to an agent instead of giving up:

```bash
AUTOREMEDIATOR_MODEL=anthropic:claude-sonnet-5-5 autoremediator runs apply <runId>
autoremediator runs apply <runId> --model openai:gpt-5 --max-repair-rounds 2
autoremediator runs apply <runId> --no-repair     # never use a model
```

Repair is on when a model is configured (`--model` or `AUTOREMEDIATOR_MODEL`) and off otherwise;
`--repair` without a model is an error before anything changes, and `--no-repair` never spends
tokens. It only applies to failures of your own checks, not to a failed install or a policy block.
The provider package (`@ai-sdk/<provider>`) must be installed next to autoremediator.

What happens:

1. **An isolated checkout.** The project is checked out as a git worktree in your user cache
   directory (not inside the project), carrying your uncommitted changes, and the upgrade is applied
   and installed there. Your project is not touched while the agent works.
2. **The agent edits project source.** It has a small set of tools: read files, search, list,
   edit or create `.js`/`.ts` source files, read the upgraded package's changelog and type
   definitions, and run your type check, tests or build, and nothing else. It cannot change
   `package.json`, lockfiles, CI workflows or the policy file, cannot read credentials (`.env`,
   `.npmrc`, keys), cannot leave the checkout, and is limited in steps, commands, time and tokens.
3. **The verifier decides.** Each time the agent submits, the verifier runs on the checkout. If it
   fails, its findings go back to the agent, up to `--max-repair-rounds` (default 3). The agent's own
   opinion that it succeeded counts for nothing.
4. **Only a verified change is applied.** It is brought into your project as a patch, re-checked there
   (scope, policy, supply chain, advisories), and taken back out with the project restored if that
   fails. Source edits are included in the run's snapshot, so `runs rollback` undoes them too.

Everything is kept with the run, under `attempts/<id>/`: the record, the patch, the agent's
transcript and the verification. `runs show` lists the attempts.

The model sees the files it reads and the output of your checks, so those go to your model
provider. Credentials are excluded, but source code is not: do not enable this where that is not
acceptable. File contents and package documentation are treated as data, and the agent is told to
ignore instructions in them; the scope limits and the verifier are what hold if that fails.

## Letting your own agent do the repair

Instead of the built-in agent, an agent you already use (Claude Code, Cursor, Copilot, a script) can
do the repair through the same isolated checkout and the same verifier. With the tools of the
[MCP server](../integrations/mcp-server.md), the HTTP routes under `/attempts/`, or the SDK:

1. `startAttempt` for a plan item opens a checkout with the upgrade applied and returns its path and
   what the verifier found wrong.
2. Fix the project there, with your agent's own file tools, or send a unified diff with
   `proposePatch`. A patch may change project source only, must be plain text, and must apply
   cleanly; binary changes, renames, mode changes and anything outside source are refused.
3. `verifyAttempt` runs the verifier and reports what is still wrong. Repeat 2 and 3.
4. `finalizeAttempt` verifies once more and, if it passes, applies the change to the project through
   the same promotion step as the built-in agent: re-checked in place, undone if that fails. It
   returns `finalized: false` with the reasons when it does not verify. `abandonAttempt` throws the
   attempt away.

Up to four attempts per run can be open at once. An attempt outlives the process that started it, and
is recorded with the run like any other. The MCP prompt `repair-upgrade` gives a host this sequence.

## Verify

`runs verify` (`verifyRun`) judges the project as it is now against what the run set out to do. It is
deterministic: no model is consulted, and what the change's author says about it is not taken on
trust. Checks run cheapest first and stop at the first failure; the rest are reported as skipped.

| Check | Passes when |
| ----- | ----------- |
| `scope` | Only dependency files changed: manifests, lockfiles, patch files, package-manager state. Never CI workflows, the policy file, `.git` or `node_modules`; project source only when the change is allowed to edit it. Skipped outside a git repository |
| `policy` | Every changed dependency is allowed by `allowPackages`/`denyPackages`, major bumps are allowed, and `directDependenciesOnly`/`preferVersionBump` are respected |
| `supply-chain` | Each new version passes the age, install-script and provenance rules, including your package manager's cooldown |
| `install` | A frozen install succeeds, so the lockfile matches the manifests |
| `vuln-gone` | No installed package still matches the advisory (findings the plan knowingly left are excepted) |
| `typecheck`, `tests` | The type checker and test script pass, when requested |
| `proof-of-fix` | The reproduction test passes now, when supplied (or fails the check when `requireProofOfFix` is set and none is) |

Applying runs the first four of these that are cheap (`scope`, `policy`, `supply-chain`,
`vuln-gone`) after every item; `runs verify` runs all of them, or only those named with `--check`.
The result is stored in the run as `verification.json` and noted in the ledger.

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
