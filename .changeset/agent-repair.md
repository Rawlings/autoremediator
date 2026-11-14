---
"autoremediator": minor
---

Agent repair: when an upgrade breaks the project's own checks, an agent adapts the project's source,
and only a change the verifier accepts is kept.

- `applyPlan` / `runs apply` hand an item that fails `--run-tests` or `--typecheck` to an agent when
  a model is configured (`model` / `--model` / `AUTOREMEDIATOR_MODEL`; `--repair` requires one,
  `--no-repair` disables it). New options: `repair`, `model`, `maxRepairRounds` (SDK also
  `repairAgent`, `repairBudget`, `signal`).
- The attempt runs in an isolated git worktree (in the user cache directory, carrying uncommitted
  changes). The built-in agent uses ai@7 with scoped tools: read, list and search files, edit or
  create `.js`/`.ts` source, read the dependency's changelog and types, and run the project's own
  type check, tests or build, within step, command, time, round and token limits. It cannot change
  manifests, lockfiles, CI, the policy or credentials, or leave the checkout.
- The verifier judges every round and its findings go back to the agent. A verified change is applied
  to the project as a patch, checked again there, and removed with the project restored if that
  fails. Source edits are part of the run's snapshot, so rollback undoes them.
- Attempts are kept with the run (`attempts/<id>/`: record, patch, transcript, verification) and listed
  by `getRun` / `runs show`.
- New `RepairAgent` port (`platform/repair-agent.ts`) for plugging in your own agent.
- Fix: the run ledger could fork when two code paths appended in turn; it now always continues from
  the file.
- Fix: a failed or rolled-back upgrade used to leave `package.json` rewritten in the tool's own
  JSON style (it showed up as a diff, and made later patches unapplicable). Both upgrade tools now
  restore the original bytes on failure and keep the file's indentation, line endings and final
  newline on success.

