# Lockfile bisect: which update broke the build

CI went red and nobody changed any code. A dependency, usually a transitive one, published a bad
release, and the lockfile (or a fresh install without one) picked it up. `autoremediator bisect`
finds which package update did it.

```bash
autoremediator bisect --good v1.4.0 --command "npm test"
autoremediator bisect --good 3f2a9c1 --bad origin/main --command "npm run build && npm run smoke" --timeout 120
```

```text
Lockfile bisect 72af7bb0a37c..77a447712728  (npm, 4 changed package version(s))
Command: npm test

   1. pass       good ref  [exit 0, 0.1s]
   2. fail       bad ref  [exit 1, 0.1s]
   3. fail       good ref + all 4 updates  [exit 1, 0.2s]
   4. pass       good ref + 2 update(s): direct-lib, leaf-a  [exit 0, 0.1s]
   5. fail       good ref + 2 update(s): leaf-b, leaf-c  [exit 1, 0.1s]
   6. fail       good ref + 1 update(s): leaf-b  [exit 1, 0.1s]
   7. pass       good ref + every update except the culprit  [exit 0, 0.1s]

leaf-b 1.0.0 -> 1.1.0 (transitive) breaks the command. Holding it at 1.0.0 makes it pass.

Output of the failing run:
  | TypeError: leaf-b@1.1.0: x is not a function
Pin back: leaf-b@1.0.0 (override)
Plan plan_70946fc9b4d669ac recorded as run run_72up3q4byuw40qaeag09; nothing was changed.
  Review: autoremediator runs show run_72up3q4byuw40qaeag09
  Apply:  autoremediator runs apply run_72up3q4byuw40qaeag09
```

(Output of a run against a local test registry, abridged: the failing run's `npm test` header lines are left out. The times are those of a tiny project.)

## What it does

1. **Diffs the lockfile** between the two refs (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
   v1) into the packages whose single locked version changed: name, from, to.
2. **Checks the endpoints.** In an isolated git worktree it installs the good ref exactly as committed
   (`npm ci`, `pnpm install --frozen-lockfile`) and runs your command: it must pass. It does the same
   for the bad ref: it must fail. Otherwise it stops with `not-reproducible` (the command is flaky,
   or depends on something outside the repository, such as a release that is no longer on the
   registry) and says which end was wrong.
3. **Checks the diagnosis is possible.** It applies *all* the changed versions to the good ref's
   tree. If the command passes there, the failure does not come from a version change of a package
   locked at both refs (a source change, an added or removed package): `not-attributable`.
4. **Narrows down.** It holds half of the changed packages at their bad-ref versions, everything else
   at the good ref's, reinstalls and runs the command, and halves again. This is delta debugging
   (ddmin): with one culprit it is a binary search (about `2 * log2(n)` runs); when no half fails on
   its own because two packages are needed together, it tries complements and finer partitions and
   returns the **smallest set that fails only together** (`culprit-set`).
5. **Confirms.** It applies every update except the culprits and checks the command passes, so
   "holding the culprits back fixes it" is something it ran (`holdingBackFixes`), not something it
   assumed.
6. **Recommends a remedy.** A plan that pins each culprit back to its good-ref version, recorded in
   `.autoremediator/runs/` like [`autoremediator plan`](plan-and-apply.md). Nothing in your project is
   changed unless you run `runs apply <runId>` or pass `--apply`.

## Options

| Flag | Meaning |
| ---- | ------- |
| `--good <ref>` | Required. Commit, tag or branch where the command passes. |
| `--bad <ref>` | Where it fails. Default `HEAD`. The committed state is used, not your working tree. |
| `--command <cmd>` | Required. Shell command, run after installing, in the checkout. Exit code 0 is a pass. |
| `--timeout <s>` | Kill the command after this long and count it as failing (default 600). Installs have their own limit of 10 minutes. |
| `--max-steps <n>` | At most this many candidate states, not counting the two refs (default 30). When it runs out you get `incomplete` and the smallest failing set so far. |
| `--package-manager <name>` | `npm`, `pnpm` or `yarn`. Default: from the lockfile at the bad ref. |
| `--ignore-scripts` | Pass `--ignore-scripts` to every install. |
| `--apply` | Apply the recommended pin through `applyPlan`. |
| `--cwd <path>` | The project, or a directory inside the repository that has its own lockfile. |
| `--output-format json` | The full report, including every step's evidence. |

Exit code: `0` when a culprit (or culprit set) was found, `1` otherwise, `130` when interrupted.

SDK:

```ts
import { bisectLockfile } from "autoremediator";

const report = await bisectLockfile({ good: "v1.4.0", command: "npm test", timeoutSeconds: 120 });
if (report.status === "culprit") console.log(report.culprits, report.remedy?.runId);
```

## The report

`status` is one of `culprit`, `culprit-set`, `not-reproducible`, `not-attributable`, `no-changes` and
`incomplete` (step limit reached or interrupted; `culprits` then holds the smallest set known to
fail). Besides the verdict it carries:

- `updates`: what was tried, with `fromVersion`, `toVersion` and `dependencyScope` (`direct` or
  `transitive`).
- `skipped`: lockfile changes that cannot be tried one package at a time, with the reason: added or
  removed packages, and packages locked in several versions (one pin cannot stand for them). They
  are never guessed at.
- `steps`: the evidence. Per step: which packages were at their new version, the install and the
  command with exit code, duration and whether it timed out, and the end of the output.
  Output is sanitized: terminal escapes, known credential shapes, the value of any environment
  variable whose name looks like a secret, home and checkout paths are removed, and only the last
  1500 characters are kept.
- `remedy`: the pins, the run and plan ids, and with `--apply` whether the lockfile now holds the
  good versions (`applied.effective`).
- `warnings`: for example when other updates also break the command, or some combinations of versions
  could not be installed and the set may not be minimal.

## How a state is built

Each candidate is a fresh checkout of the good ref (`git reset --hard` and `git clean -fdx`, so no
installed packages carry over) with the chosen packages held at their bad-ref versions:

| Package kind | npm | pnpm | yarn (classic) |
| ------------ | --- | ---- | -------------- |
| Direct dependency | exact version in `package.json` (npm refuses an override for a direct dependency) | same | same |
| Transitive | `overrides` in `package.json` | `overrides` in `pnpm-workspace.yaml` for pnpm 11 and later, `pnpm.overrides` in `package.json` before | `resolutions` in `package.json` |

then a normal, non-frozen install (the lockfile has to move). Afterwards the written lockfile is
read back and **every changed package must be at exactly the version the state asked for**; if the
package manager did not honour a pin, the state is `unresolved` and says why, rather than producing a
confident wrong answer. A candidate that cannot be installed is also `unresolved`. Unresolved states
count as "not failing" for the search and are reported as a warning.

An install that fails in the good or bad ref (a broken build as committed) counts as a failure of
that ref; an install failing in a combination the tool made up does not.

## Support

| | Status |
| - | ------ |
| npm (`package-lock.json`) | Implemented and tested end to end against real npm. |
| pnpm (`pnpm-lock.yaml`) | Implemented and tested end to end against real pnpm 12 (overrides in `pnpm-workspace.yaml`). pnpm 10 and earlier (`pnpm.overrides` in `package.json`) is implemented but not run. |
| yarn classic (`yarn.lock` v1) | Lockfile parsing is tested; the pins (`resolutions`, exact versions) and the install commands are implemented but **not run against a real yarn**. |
| yarn berry, bun, deno | Not supported: berry's lockfile format and `bun.lock` are not parsed. The command stops with an error before running anything. |
| Workspaces / monorepos | Only the root `package.json` is pinned. A package declared only inside a workspace member is pinned as an override, which has not been tested against workspace-specific behaviour. |

## Trust model

`bisect` runs two kinds of code, both with **your privileges, exactly as if you ran them yourself**:

- **Your `--command`.** It runs through `/bin/sh -c` in the checkout (never in your project
  directory), with your environment minus a few variables that can inject code into a process
  (`NODE_OPTIONS`, `LD_PRELOAD` and similar).
- **Package install scripts**, in every install of every candidate, including versions you have not
  run before. That is the point of the exercise (a bad release is what you are hunting), but it is
  also how a malicious release would run. Use `--ignore-scripts` if the command does not need them.

This is why `bisect` is only on the command line and in the SDK. It is deliberately **not** an MCP
tool or an HTTP route: an agent or a remote caller that can reach those could run an arbitrary shell
command through it.

Timeouts and Ctrl-C end the command's whole process group, so nothing is left running in a checkout
that is about to be deleted. The worktrees (under your user cache directory, not inside the project)
are removed when the run ends, on errors, on a timeout, on the first Ctrl-C, and, as a synchronous
fallback, when the process exits. A second Ctrl-C exits immediately. If the process is killed with
`SIGKILL`, nothing can clean up; run `git worktree prune` and delete the leftovers in
`~/.cache/autoremediator/worktrees/`.

The only things written to your project are the plan under `.autoremediator/runs/`, and, with
`--apply`, the pin itself.

## Limits to know about

- **A flaky command gives a wrong answer.** The endpoints are each run once; a command that fails
  at random can send the search the wrong way. Make the command deterministic, or run bisect twice.
- **Timeout counts as failing.** A release that makes the command hang is found, but so is a command
  that is merely slow: pick `--timeout` with headroom.
- **The registry must still serve the versions.** Both refs are reinstalled from the registry; a bad
  release that was unpublished makes the bad ref uninstallable (`not-reproducible`).
- **Version resolution can drift.** A pinned package's own dependencies are resolved fresh, which
  can differ from the bad lockfile. The check above catches changes to the packages being searched,
  not to anything else.
- **`--apply` and pnpm 11 or later.** The existing override step writes `pnpm.overrides` in
  `package.json`, which pnpm 11 and later ignore. For a *transitive* culprit on such a project
  `--apply` reports `applied.effective: false` after checking the lockfile, and the note says to roll
  the run back or pin it by hand in `pnpm-workspace.yaml`. Direct dependencies are pinned by an exact
  version in `package.json` and work everywhere.
- **Your working tree must hold the bad version.** The plan is made for the project as it is. A
  culprit that your working tree no longer locks at the bad version (already fixed) is listed under
  `remedy.notPlanned` instead of planned.
