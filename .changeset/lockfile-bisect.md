---
"autoremediator": minor
---

Lockfile bisect: `autoremediator bisect --good <ref> [--bad <ref>] --command "<shell command>"` and the `bisectLockfile` SDK function find which package update in the lockfile diff between two git refs makes a command fail.

- Diffs `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` (v1) between the refs, checks in isolated git worktrees that the command passes at the good ref and fails at the bad one (otherwise `not-reproducible`), and that applying every changed version to the good ref reproduces the failure (otherwise `not-attributable`).
- Narrows down with delta debugging (ddmin): a binary search for one culprit, and the smallest set that fails only together when two updates interact. Each state holds a subset of packages at their bad-ref versions (exact version for direct dependencies; `overrides`, `pnpm-workspace.yaml` overrides or `resolutions` for transitive ones), reinstalls, verifies from the written lockfile that the requested versions were installed, and runs the command with a timeout.
- The report carries the evidence (commands, exit codes, durations, sanitized output tail per step) and a remedy: a plan recorded as a run that pins each culprit back to its good version. `--apply` applies it through `applyPlan` and then checks the lockfile actually holds the good version.
- Worktrees and the command's process tree are removed on completion, errors, timeouts and Ctrl-C. `--ignore-scripts`, `--timeout`, `--max-steps`, `--package-manager`, `--cwd` and `--output-format json` are supported.
- npm and pnpm are tested end to end against a local registry. yarn classic is implemented but not exercised against a real yarn; yarn berry and bun lockfiles are not supported.
- New catalog operation `bisectLockfile` (CLI and SDK only; deliberately not an MCP tool or HTTP route, because it runs an arbitrary shell command and package install scripts).
- `applyPlan`/`runs apply`: a version bump that goes to a lower version now writes the exact version (a range such as `^1.0.0` lets the package manager keep the locked newer release).
- New guide: `docs/guides/bisect.md`.
